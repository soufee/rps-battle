import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getBotDisplayName } from './BotDiscovery.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class MatchRunner {
  constructor(options = {}) {
    this.headed = options.headed !== false;
    this.slowMo = options.slowMo || 0;
    this.timeout = options.timeout || 300000; // 5 min per match
    this.captureScreenshots = options.captureScreenshots !== false;
    this.resultsDir = options.resultsDir || path.resolve(__dirname, 'screenshots');
    this.accelerate = options.accelerate !== false;

    this.browser = null;
    this.context = null;
    this.page = null;
    this.localServerPort = options.serverPort || 3001;

    /** @type {boolean} Soft-stop flag (tournament stop). Does NOT close browser by itself. */
    this._aborted = false;
    /** @type {Array<() => void>} */
    this._abortWaiters = [];
  }

  get aborted() {
    return this._aborted;
  }

  async ensureBrowser() {
    if (this.browser) return;

    this.browser = await chromium.launch({
      headless: !this.headed,
      slowMo: this.slowMo,
      args: ['--disable-dev-shm-usage', '--no-sandbox']
    });

    this.context = await this.browser.newContext({
      viewport: { width: 1400, height: 900 },
      ignoreHTTPSErrors: true
    });

    // Install hooks once per context (before any page loads)
    await this.context.addInitScript(() => {
      window.__matchResult = null;
      window.__matchBoardReady = false;
      window.__matchStarted = false;
      window.__battleLogs = window.__battleLogs || [];

      const recordResult = (playerWon, reason) => {
        try {
          const gs = (window.gameCore && window.gameCore.gameState) || {};
          window.__matchResult = {
            winnerSide: playerWon === 'draw' ? 'draw' : (playerWon ? 'bottom' : 'top'),
            reason: reason || 'unknown',
            topBotId: gs.topBotId || null,
            bottomBotId: gs.bottomBotId || null,
            topPieceCount: (gs.aiPieces || []).filter(p => !p.removed).length,
            bottomPieceCount: (gs.playerPieces || []).filter(p => !p.removed).length,
            totalMoves: (typeof aiEngine !== 'undefined' && aiEngine.aiTurnCounter) || null,
            capturedAt: Date.now()
          };
        } catch (e) {
          window.__matchResult = {
            winnerSide: playerWon === 'draw' ? 'draw' : (playerWon ? 'bottom' : 'top'),
            reason: 'hook_error'
          };
        }
      };

      // Preserve app's gameCore if already present; always wrap endGame
      const install = () => {
        const prev = window.gameCore || { gameState: null, endGame: null };
        if (prev.__champHooked) return;
        window.gameCore = {
          gameState: prev.gameState ?? null,
          __champHooked: true,
          endGame: (playerWon, reason) => {
            recordResult(playerWon, reason);
            if (typeof prev.endGame === 'function') {
              try { prev.endGame(playerWon, reason); } catch (_) { /* ignore */ }
            }
          }
        };
      };
      install();
      // Re-install after app bundle may overwrite gameCore
      document.addEventListener('DOMContentLoaded', install);
      setTimeout(install, 0);
      setTimeout(install, 50);
      setTimeout(install, 200);
    });
  }

  /**
   * Soft abort: signal runMatch to finish as draw, but leave browser open
   * long enough to scrape battle log + board screenshot.
   */
  async abort() {
    this._aborted = true;
    const waiters = this._abortWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  _waitForAbort() {
    if (this._aborted) return Promise.resolve();
    return new Promise((resolve) => {
      this._abortWaiters.push(resolve);
    });
  }

  async close() {
    if (this.context) await this.context.close().catch(() => {});
    if (this.browser) await this.browser.close().catch(() => {});
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  _ensureShotDir() {
    if (!fs.existsSync(this.resultsDir)) {
      fs.mkdirSync(this.resultsDir, { recursive: true });
    }
  }

  _buildResult({
    matchId,
    startTime,
    topBotId,
    bottomBotId,
    matchMeta,
    gameResult,
    finalBattleLog,
    screenshotPath,
    forcedDraw = false
  }) {
    const endTime = new Date();
    const durationMs = endTime - startTime;

    const result = {
      matchId,
      startedAt: startTime.toISOString(),
      finishedAt: endTime.toISOString(),
      durationMs,
      durationSec: Math.round(durationMs / 1000),
      topBotId,
      bottomBotId,
      topBotName: getBotDisplayName(topBotId),
      bottomBotName: getBotDisplayName(bottomBotId),
      reason: forcedDraw
        ? 'stopped'
        : (gameResult ? (gameResult.reason || null) : null),
      totalMoves: gameResult ? (gameResult.totalMoves || null) : null,
      timedOut: !!(gameResult && gameResult.timedOut),
      result: forcedDraw
        ? { gameOver: true, winnerSide: 'draw', reason: 'stopped' }
        : gameResult,
      battleLog: finalBattleLog || [],
      screenshot: screenshotPath ? `screenshots/${path.basename(screenshotPath)}` : null,
      meta: matchMeta,
      winner: 'draw',
      loser: null
    };

    if (!forcedDraw && gameResult && gameResult.winnerSide === 'top') {
      result.winner = 'top';
      result.loser = 'bottom';
    } else if (!forcedDraw && gameResult && gameResult.winnerSide === 'bottom') {
      result.winner = 'bottom';
      result.loser = 'top';
    }

    return result;
  }

  async _scrapeLogs(page) {
    try {
      return await page.evaluate(() => {
        const logs = window.__battleLogs || [];
        return logs.map((msg) =>
          typeof msg === 'string' ? { message: msg } : (msg?.message != null ? msg : { message: String(msg) })
        );
      });
    } catch (e) {
      console.warn('[MatchRunner] Failed to read battle logs:', e.message);
      return [];
    }
  }

  /**
   * Capture the game board (prefer board element). Full page as fallback.
   * Avoid capturing the login screen when possible.
   */
  async _captureFinalBoard(page, screenshotPath) {
    this._ensureShotDir();
    try {
      // Prefer the real board element
      const board = page.locator('#game-board, [data-testid="game-board"], [aria-label="game-board"]').first();
      const boardVisible = await board.isVisible({ timeout: 1500 }).catch(() => false);

      if (boardVisible) {
        await board.screenshot({ path: screenshotPath });
        console.log(`[MatchRunner] Board screenshot saved: ${screenshotPath}`);
        return true;
      }

      // Check we are not on auth UI before full-page shot
      const pageInfo = await page.evaluate(() => {
        const text = (document.body && document.body.innerText) || '';
        const hasBoard =
          !!document.getElementById('game-board') ||
          !!document.querySelector('[data-testid="game-board"]') ||
          !!document.querySelector('[aria-label="game-board"]');
        const gs = window.gameCore && window.gameCore.gameState;
        const looksAuth =
          !hasBoard &&
          (/Войти через|Login with Google|Google|VK ID|войти как гость/i.test(text));
        return {
          hasBoard,
          gameOver: !!(gs && gs.gameOver),
          phase: gs?.phase || null,
          looksAuth,
          started: !!window.__matchStarted
        };
      }).catch(() => ({ looksAuth: false }));

      if (pageInfo.looksAuth) {
        console.warn('[MatchRunner] Auth screen visible — skipping misleading screenshot');
        return false;
      }

      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`[MatchRunner] Full-page screenshot saved: ${screenshotPath}`);
      return true;
    } catch (err) {
      console.warn('[MatchRunner] Screenshot failed:', err.message);
      return false;
    }
  }

  async _waitForMatchStart(page, timeoutMs = 25000) {
    await page.waitForFunction(() => {
      if (window.__matchStarted) return true;
      const board =
        document.getElementById('game-board') ||
        document.querySelector('[data-testid="game-board"]') ||
        document.querySelector('[aria-label="game-board"]');
      const gs = window.gameCore && window.gameCore.gameState;
      // Playing or finished board is present
      if (board && gs && (gs.phase === 'playing' || gs.phase === 'finished' || gs.gameOver)) {
        return true;
      }
      // Dev match pieces already on board
      if (gs && Array.isArray(gs.playerPieces) && gs.playerPieces.length > 0) {
        return true;
      }
      return false;
    }, null, { timeout: timeoutMs });
  }

  async _readGameResult(page) {
    return page.evaluate(() => {
      const state = (typeof window.gameCore !== 'undefined' && window.gameCore.gameState) || {};
      const hooked = window.__matchResult;
      return {
        gameOver: true,
        phase: state.phase,
        topBotId: state.topBotId,
        bottomBotId: state.bottomBotId,
        winnerSide: hooked
          ? hooked.winnerSide
          : (state.winner === 'draw' ? 'draw' : (state.winner === 'player' ? 'bottom' : 'top')),
        reason: hooked ? hooked.reason : (state.endReason || null),
        topPieceCount: hooked
          ? hooked.topPieceCount
          : (state.aiPieces || []).filter(p => !p.removed).length,
        bottomPieceCount: hooked
          ? hooked.bottomPieceCount
          : (state.playerPieces || []).filter(p => !p.removed).length,
        totalMoves: hooked ? hooked.totalMoves : null
      };
    });
  }

  /**
   * Run a single championship match. Soft-abort → draw with logs + board shot if possible.
   */
  async runMatch(topBotId, bottomBotId, matchMeta = {}) {
    if (this._aborted) {
      const matchId = `match_${Date.now()}_${topBotId}_vs_${bottomBotId}`;
      return this._buildResult({
        matchId,
        startTime: new Date(),
        topBotId,
        bottomBotId,
        matchMeta,
        gameResult: null,
        finalBattleLog: [],
        screenshotPath: null,
        forcedDraw: true
      });
    }

    await this.ensureBrowser();

    const matchId = `match_${Date.now()}_${topBotId}_vs_${bottomBotId}`;
    const startTime = new Date();

    console.log(`[MatchRunner] === Starting match ${topBotId} vs ${bottomBotId} (id: ${matchId}) ===`);
    console.log(`[MatchRunner] Using server port: ${this.localServerPort}`);

    const page = await this.context.newPage();
    this.page = page;

    page.on('console', msg => {
      console.log(`[BROWSER:${msg.type().toUpperCase()}] ${msg.text()}`);
    });
    page.on('pageerror', err => {
      console.error(`[BROWSER PAGEERROR] ${err.message}`);
    });

    let gameResult = null;
    let finalBattleLog = [];
    let screenshotPath = null;
    let forcedDraw = false;
    let launchFailed = false;

    const gameUrl = `http://localhost:${this.localServerPort}/?championship=true&top=${encodeURIComponent(topBotId)}&bottom=${encodeURIComponent(bottomBotId)}&speed=${this.accelerate ? 15 : 1}`;

    const playMatch = async () => {
      console.log(`[MatchRunner] Navigating to ${gameUrl}`);
      try {
        await page.goto(gameUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch (navErr) {
        if (this._aborted) return { aborted: true };
        console.error(`[MatchRunner] Navigation failed:`, navErr.message);
        return { launchFailed: true, error: navErr.message };
      }

      if (this._aborted) return { aborted: true };

      // Wait until championship board actually starts (not auth splash)
      try {
        await this._waitForMatchStart(page, 25000);
      } catch (startErr) {
        if (this._aborted) return { aborted: true };
        console.error(`[MatchRunner] Match failed to start (board never appeared):`, startErr.message);
        // One retry
        try {
          await page.goto(gameUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await this._waitForMatchStart(page, 20000);
        } catch (retryErr) {
          if (this._aborted) return { aborted: true };
          console.error(`[MatchRunner] Retry start failed:`, retryErr.message);
          return { launchFailed: true, error: retryErr.message };
        }
      }

      if (this._aborted) return { aborted: true };

      console.log(`[MatchRunner] Match started — waiting for result (timeout ${this.timeout}ms)...`);
      try {
        await page.waitForFunction(() => {
          return window.__matchResult !== null
              || (window.gameCore
                  && window.gameCore.gameState
                  && window.gameCore.gameState.gameOver === true);
        }, null, { timeout: this.timeout });

        if (this._aborted) return { aborted: true };

        // Wait for React to paint finished board
        try {
          await page.waitForFunction(() => {
            if (window.__matchBoardReady) return true;
            const board =
              document.getElementById('game-board') ||
              document.querySelector('[data-testid="game-board"]') ||
              document.querySelector('[aria-label="game-board"]');
            const gs = window.gameCore && window.gameCore.gameState;
            return !!(board && gs && gs.gameOver === true);
          }, null, { timeout: 5000 });
        } catch (_) { /* best-effort */ }

        await page.waitForTimeout(350);
        const result = await this._readGameResult(page);
        return { gameResult: result };
      } catch (err) {
        if (this._aborted) return { aborted: true };
        console.error(`[MatchRunner] Match timed out:`, err.message);
        return { gameResult: { gameOver: false, error: err.message, timedOut: true, reason: 'timeout' } };
      }
    };

    try {
      const playPromise = playMatch().catch((err) => {
        if (this._aborted) return { aborted: true };
        return { gameResult: { gameOver: false, error: err.message, timedOut: true, reason: 'error' } };
      });

      const raced = await Promise.race([
        playPromise,
        this._waitForAbort().then(() => ({ aborted: true, fromAbort: true }))
      ]);

      // If stop won the race, give the natural finish a brief chance (match may have just ended)
      let outcome = raced;
      if (raced?.fromAbort || this._aborted) {
        const natural = await Promise.race([
          playPromise,
          new Promise((resolve) => setTimeout(() => resolve(null), 400))
        ]);
        if (natural?.gameResult?.gameOver && !natural.aborted && !natural.launchFailed) {
          outcome = natural;
          console.log(`[MatchRunner] Match ${matchId} finished naturally during stop — keeping real result`);
        } else {
          outcome = { aborted: true };
        }
      }

      // Prevent unhandled rejection if playPromise is still running
      playPromise.catch(() => {});

      if (outcome?.aborted || (this._aborted && !outcome?.gameResult?.gameOver)) {
        forcedDraw = true;
        console.log(`[MatchRunner] Match ${matchId} aborted — recording draw (stopped), capturing board/log first`);
      } else if (outcome?.launchFailed) {
        launchFailed = true;
        gameResult = {
          gameOver: false,
          error: outcome.error || 'launch_failed',
          reason: 'launch_failed',
          timedOut: false,
          winnerSide: 'draw'
        };
        console.error(`[MatchRunner] Match ${matchId} failed to launch`);
      } else {
        gameResult = outcome?.gameResult || null;
      }

      // Always try to scrape logs + screenshot while page is still alive
      // (including abort/stop — board after last completed move)
      finalBattleLog = await this._scrapeLogs(page);

      if (this.captureScreenshots && !launchFailed) {
        this._ensureShotDir();
        const shotFile = path.join(this.resultsDir, `${matchId}.png`);
        const ok = await this._captureFinalBoard(page, shotFile);
        if (ok) screenshotPath = shotFile;
      }

      // Launch-fail diagnostics only (not shown as official board shot)
      if (this.captureScreenshots && launchFailed) {
        this._ensureShotDir();
        const shotFile = path.join(this.resultsDir, `${matchId}_LAUNCH_FAIL.png`);
        await page.screenshot({ path: shotFile, fullPage: true }).catch(() => {});
      }
    } catch (err) {
      if (this._aborted) {
        forcedDraw = true;
      } else {
        console.error(`[MatchRunner] Unexpected error:`, err.message);
        gameResult = { gameOver: false, error: err.message, timedOut: true, reason: 'error' };
      }
    }

    const result = this._buildResult({
      matchId,
      startTime,
      topBotId,
      bottomBotId,
      matchMeta,
      gameResult,
      finalBattleLog,
      screenshotPath,
      forcedDraw
    });

    if (launchFailed && !forcedDraw) {
      result.reason = 'launch_failed';
      result.winner = 'draw';
      result.loser = null;
    }

    console.log(
      `[MatchRunner] Match ${matchId} finished. Winner: ${result.winner}, reason: ${result.reason}, ` +
      `logs: ${finalBattleLog.length}, shot: ${!!screenshotPath}, duration: ${result.durationSec}s`
    );

    await page.close().catch(() => {});
    return result;
  }
}

export default MatchRunner;
