import MatchRunner from './MatchRunner.js';
import Standings from './Standings.js';
import { getBotDisplayName } from './BotDiscovery.js';
import prisma from '../models/db.js';

class TournamentEngine {
  constructor(options = {}) {
    this.options = {
      headed: false,
      concurrency: 1,
      timeoutPerMatch: 300000,
      accelerate: true,
      ...options
    };

    this.serverPort = options.serverPort || 3001;

    this.standings = new Standings();
    this.currentSchedule = null;
    this.championshipId = null;
    this.progress = { completed: 0, total: 0, activeMatches: [] };
    this.listeners = [];
    this._isStopped = false;
    this._isRunning = false;
    this.activeRunners = new Set();
    /** @type {Promise|null} resolves when the current tournament fully ends */
    this._runPromise = null;
  }

  on(event, cb) {
    this.listeners.push({ event, cb });
  }

  _emit(event, data) {
    this.listeners.forEach(l => {
      if (l.event === event) l.cb(data);
    });
  }

  isRunning() {
    return this._isRunning;
  }

  async runTournament(schedule) {
    this.currentSchedule = schedule;
    this.standings.reset();
    this.progress = { completed: 0, total: 0, activeMatches: [] };
    this._isStopped = false;
    this._isRunning = true;

    // Flatten all matches
    const allMatches = [];
    for (const round of schedule.rounds || []) {
      for (const m of (round.matches || [])) {
        allMatches.push({
          round: round.round || round.number || 1,
          top: m.top || m.botA,
          bottom: m.bottom || m.botB,
          meta: { ...m }
        });
      }
    }

    this.progress.total = allMatches.length;

    // Create the championship record in the database
    const champ = await prisma.championship.create({
      data: {
        name: schedule.name || 'Чемпионат',
        status: 'running',
        totalMatches: allMatches.length,
        schedule: schedule,
        standings: this.standings.toJSON()
      }
    });
    this.championshipId = champ.id;

    const results = [];
    const queue = [...allMatches];
    const concurrency = Math.max(1, this.options.concurrency || 1);
    let currentIndex = 0;
    let activeWorkers = 0;
    let resolved = false;

    const LAUNCH_SPACING_MS = 600;
    let lastLaunchTs = 0;
    const throttleLaunch = async () => {
      const now = Date.now();
      const wait = Math.max(0, LAUNCH_SPACING_MS - (now - lastLaunchTs));
      lastLaunchTs = now + wait;
      if (wait > 0) {
        await new Promise(r => setTimeout(r, wait));
      }
    };

    const persistMatch = async (result) => {
      await prisma.championshipMatch.create({
        data: {
          id: result.matchId,
          championshipId: this.championshipId,
          round: result.meta?.round || 1,
          topBotId: result.topBotId,
          bottomBotId: result.bottomBotId,
          topBotName: result.topBotName,
          bottomBotName: result.bottomBotName,
          winner: result.winner,
          loser: result.loser,
          reason: result.reason || 'unknown',
          durationSec: result.durationSec,
          totalMoves: result.totalMoves,
          timedOut: result.timedOut,
          battleLog: result.battleLog,
          screenshotPath: result.screenshot
        }
      });

      await prisma.championship.update({
        where: { id: this.championshipId },
        data: {
          completedMatches: this.progress.completed,
          standings: this.standings.toJSON()
        }
      });
    };

    const makeStoppedDraw = (match, matchIndex) => {
      const matchId = `match_${Date.now()}_${match.top}_vs_${match.bottom}_stopped_${matchIndex}`;
      return {
        matchId,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        durationSec: 0,
        topBotId: match.top,
        bottomBotId: match.bottom,
        topBotName: getBotDisplayName(match.top),
        bottomBotName: getBotDisplayName(match.bottom),
        reason: 'stopped',
        totalMoves: null,
        timedOut: false,
        result: { gameOver: true, winnerSide: 'draw', reason: 'stopped' },
        battleLog: [],
        screenshot: null,
        meta: { round: match.round, scheduleName: schedule.name },
        winner: 'draw',
        loser: null
      };
    };

    this._runPromise = new Promise((resolve) => {
      const maybeFinish = async () => {
        if (resolved) return;
        if (activeWorkers !== 0) return;
        // When stopped, ignore remaining queue (unplayed matches are not started)
        if (queue.length > 0 && !this._isStopped) return;

        resolved = true;
        // Ensure progress reflects full completion for UI (e.g. 12/12)
        if (!this._isStopped && this.progress.total > 0) {
          this.progress.completed = Math.max(this.progress.completed, this.progress.total);
        }
        this.progress.activeMatches = [];
        // Clear remaining unplayed matches from the queue so isRunning checks are clean
        queue.length = 0;

        console.log(
          `[Tournament] Finalizing "${schedule.name}": ` +
          `${this.progress.completed}/${this.progress.total}, stopped=${this._isStopped}`
        );

        // Finalize championship status in the DB
        try {
          await prisma.championship.update({
            where: { id: this.championshipId },
            data: {
              status: this._isStopped ? 'stopped' : 'finished',
              finishedAt: new Date(),
              completedMatches: this.progress.completed,
              standings: this.standings.toJSON()
            }
          });
        } catch (err) {
          console.error('[Tournament] Failed to finalize in DB:', err);
        }

        this._isRunning = false;

        const finishPayload = {
          schedule: schedule.name,
          results,
          standings: this.standings.toJSON(),
          stopped: this._isStopped,
          progress: {
            completed: this.progress.completed,
            total: this.progress.total,
            activeMatches: []
          }
        };

        this._emit('tournament:finished', finishPayload);
        console.log(`[Tournament] Emitted tournament:finished (stopped=${this._isStopped})`);

        resolve({ results, standings: this.standings.getSortedTable(), stopped: this._isStopped });
      };

      const pump = () => {
        while (!this._isStopped && activeWorkers < concurrency && queue.length > 0) {
          const match = queue.shift();
          activeWorkers++;
          runOne(match);
        }
        // Fire-and-forget is fine: maybeFinish is idempotent via `resolved`
        void maybeFinish();
      };

      const runOne = async (match) => {
        const matchIndex = currentIndex++;
        const activeItem = {
          id: `${match.top}-${match.bottom}-${matchIndex}`,
          text: `${match.top} vs ${match.bottom} (раунд ${match.round})`
        };

        let runner = null;

        try {
          if (this._isStopped) return;

          await throttleLaunch();
          if (this._isStopped) return;

          runner = new MatchRunner({
            headed: this.options.headed,
            timeout: this.options.timeoutPerMatch,
            accelerate: this.options.accelerate,
            serverPort: this.serverPort
          });
          this.activeRunners.add(runner);
          this.progress.activeMatches.push(activeItem);
          this._emit('match:start', { match, index: matchIndex, progress: this.progress });

          try {
            const result = await runner.runMatch(match.top, match.bottom, {
              round: match.round,
              scheduleName: schedule.name
            });

            // Soft-abort mid-match → draw (MatchRunner already scraped log/shot when possible)
            if (runner.aborted || result.reason === 'stopped') {
              result.winner = 'draw';
              result.loser = null;
              result.reason = 'stopped';
            }

            // Launch failures count as draw but with a distinct reason (not "stopped")
            if (result.reason === 'launch_failed') {
              result.winner = 'draw';
              result.loser = null;
            }

            this.standings.processMatch(result);
            results.push(result);
            this.progress.completed++;

            try {
              await persistMatch(result);
            } catch (dbErr) {
              console.error('[Tournament] Failed to persist match:', dbErr);
            }

            this._emit('match:finished', {
              result,
              standings: this.standings.toJSON(),
              progress: this.progress
            });
          } catch (err) {
            console.error('[Tournament] Match failed:', err);

            // On stop (or crash during stop), record as draw so standings stay consistent.
            // Prefer any partial result the runner may have already produced.
            if (this._isStopped || (runner && runner.aborted)) {
              const drawResult = makeStoppedDraw(match, matchIndex);

              this.standings.processMatch(drawResult);
              results.push(drawResult);
              this.progress.completed++;

              try {
                await persistMatch(drawResult);
              } catch (dbErr) {
                console.error('[Tournament] Failed to persist stopped draw:', dbErr);
              }

              this._emit('match:finished', {
                result: drawResult,
                standings: this.standings.toJSON(),
                progress: this.progress
              });
            } else {
              // Unexpected crash — count as draw with error reason so table stays consistent
              const failResult = makeStoppedDraw(match, matchIndex);
              failResult.reason = 'match_error';
              failResult.result = { gameOver: true, winnerSide: 'draw', reason: 'match_error', error: err.message };
              this.standings.processMatch(failResult);
              results.push(failResult);
              this.progress.completed++;
              try {
                await persistMatch(failResult);
              } catch (dbErr) {
                console.error('[Tournament] Failed to persist error draw:', dbErr);
              }
              this._emit('match:error', { match, error: err.message || String(err) });
              this._emit('match:finished', {
                result: failResult,
                standings: this.standings.toJSON(),
                progress: this.progress
              });
            }
          } finally {
            if (runner) {
              await runner.close().catch(() => {});
              this.activeRunners.delete(runner);
            }
            this.progress.activeMatches = this.progress.activeMatches
              .filter(m => m.id !== activeItem.id);
          }
        } catch (outerErr) {
          console.error('[Tournament] Worker crashed:', outerErr);
          this.progress.activeMatches = this.progress.activeMatches
            .filter(m => m.id !== activeItem.id);
          if (runner) {
            this.activeRunners.delete(runner);
          }
        } finally {
          activeWorkers--;
          pump();
        }
      };

      pump();
    });

    // Do not await the full tournament here — callers (start API) need the
    // championshipId immediately so the UI can bind "Сыгранные матчи" to this draw.
    this._runPromise
      .catch((err) => console.error('[Tournament] runPromise error:', err))
      .finally(() => {
        this._isRunning = false;
      });

    return {
      championshipId: this.championshipId,
      name: champ.name,
      totalMatches: allMatches.length
    };
  }

  getLiveState() {
    const total = this.progress?.total || 0;
    const completed = this.progress?.completed || 0;
    // Defensive: if all matches are done, never report isRunning to the UI
    const effectivelyRunning =
      this._isRunning &&
      !(total > 0 && completed >= total && (this.progress.activeMatches || []).length === 0);

    return {
      isRunning: effectivelyRunning,
      isStopped: this._isStopped,
      progress: {
        completed,
        total,
        activeMatches: effectivelyRunning ? (this.progress.activeMatches || []) : []
      },
      standings: this.standings.toJSON(),
      currentSchedule: this.currentSchedule ? this.currentSchedule.name : null,
      championshipId: this.championshipId
    };
  }

  /**
   * Stop the championship:
   * - no new matches start
   * - in-progress matches end as draws (reason: stopped)
   * - unplayed queue matches are dropped
   * - final standings are based on completed (+ forced-draw) games
   * Resolves when the tournament has fully finalized.
   */
  async stop() {
    if (!this._isRunning && this.activeRunners.size === 0) {
      this._isStopped = true;
      return { ok: true, alreadyStopped: true };
    }

    console.log('[Tournament] Stop requested — soft-abort active matches (draw + keep board/log)');
    this._isStopped = true;

    // Soft-abort: runners scrape log+screenshot then finish as draws. Do NOT hard-close yet.
    const runners = [...this.activeRunners];
    await Promise.all(runners.map(r => r.abort().catch(err => {
      console.error('[Tournament] Failed to abort runner:', err);
    })));

    // Wait for workers to finish recording draws (with assets) and maybeFinish to run
    if (this._runPromise) {
      try {
        await Promise.race([
          this._runPromise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Stop timeout')), 45000)
          )
        ]);
      } catch (err) {
        console.error('[Tournament] Stop wait failed:', err.message);
        // Force finalize if workers hung
        if (this._isRunning && this.championshipId) {
          this._isRunning = false;
          try {
            await prisma.championship.update({
              where: { id: this.championshipId },
              data: {
                status: 'stopped',
                finishedAt: new Date(),
                completedMatches: this.progress.completed,
                standings: this.standings.toJSON()
              }
            });
          } catch (dbErr) {
            console.error('[Tournament] Force finalize failed:', dbErr);
          }
          this.progress.activeMatches = [];
          this._emit('tournament:finished', {
            schedule: this.currentSchedule?.name,
            standings: this.standings.toJSON(),
            stopped: true,
            progress: { ...this.progress }
          });
        }
      }
    }

    this.activeRunners.clear();
    this._isRunning = false;
    return { ok: true, stopped: true };
  }

  /** @deprecated use stop() — kept for compatibility */
  async close() {
    return this.stop();
  }
}

export default TournamentEngine;
