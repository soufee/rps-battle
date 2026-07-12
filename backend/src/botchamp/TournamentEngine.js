import MatchRunner from './MatchRunner.js';
import Standings from './Standings.js';
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
    this.activeRunners = new Set();
  }

  on(event, cb) {
    this.listeners.push({ event, cb });
  }

  _emit(event, data) {
    this.listeners.forEach(l => {
      if (l.event === event) l.cb(data);
    });
  }

  async runTournament(schedule) {
    this.currentSchedule = schedule;
    this.standings.reset();
    this.progress = { completed: 0, total: 0, activeMatches: [] };
    this._isStopped = false;

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

    return new Promise((resolve) => {
      const maybeFinish = async () => {
        if (resolved) return;
        if (activeWorkers !== 0) return;
        if (queue.length > 0 && !this._isStopped) return;
        
        resolved = true;
        this.progress.activeMatches = [];

        // Finalize championship status in the DB
        await prisma.championship.update({
          where: { id: this.championshipId },
          data: {
            status: this._isStopped ? 'stopped' : 'finished',
            finishedAt: new Date(),
            standings: this.standings.toJSON()
          }
        }).catch(err => console.error('[Tournament] Failed to finalize in DB:', err));

        this._emit('tournament:finished', {
          schedule: schedule.name,
          results,
          standings: this.standings.toJSON(),
          stopped: this._isStopped
        });
        
        resolve({ results, standings: this.standings.getSortedTable() });
      };

      const pump = () => {
        while (!this._isStopped && activeWorkers < concurrency && queue.length > 0) {
          const match = queue.shift();
          activeWorkers++;
          runOne(match);
        }
        maybeFinish();
      };

      const runOne = async (match) => {
        const matchIndex = currentIndex++;
        const activeItem = {
          id: `${match.top}-${match.bottom}-${matchIndex}`,
          text: `${match.top} vs ${match.bottom} (раунд ${match.round})`
        };

        try {
          if (this._isStopped) return;

          await throttleLaunch();
          if (this._isStopped) return;

          const runner = new MatchRunner({
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
            
            this.standings.processMatch(result);
            results.push(result);
            this.progress.completed++;

            // Insert match into DB
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

            // Update live progress and standings in the DB
            await prisma.championship.update({
              where: { id: this.championshipId },
              data: {
                completedMatches: this.progress.completed,
                standings: this.standings.toJSON()
              }
            });

            this._emit('match:finished', {
              result,
              standings: this.standings.toJSON(),
              progress: this.progress
            });
          } catch (err) {
            console.error('[Tournament] Match failed:', err);
            this.progress.completed++;
            this._emit('match:error', { match, error: err.message || String(err) });
          } finally {
            await runner.close().catch(() => {});
            this.activeRunners.delete(runner);
            this.progress.activeMatches = this.progress.activeMatches
              .filter(m => m.id !== activeItem.id);
          }
        } catch (outerErr) {
          console.error('[Tournament] Worker crashed:', outerErr);
          this.progress.activeMatches = this.progress.activeMatches
            .filter(m => m.id !== activeItem.id);
        } finally {
          activeWorkers--;
          pump();
        }
      };

      pump();
    });
  }

  getLiveState() {
    return {
      progress: this.progress,
      standings: this.standings.toJSON(),
      currentSchedule: this.currentSchedule ? this.currentSchedule.name : null,
      championshipId: this.championshipId
    };
  }

  async close() {
    this._isStopped = true;
    for (const runner of this.activeRunners) {
      await runner.close().catch(() => {});
    }
    this.activeRunners.clear();
  }
}

export default TournamentEngine;
