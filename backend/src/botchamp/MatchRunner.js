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
  }

  async close() {
    if (this.context) await this.context.close().catch(() => {});
    if (this.browser) await this.browser.close().catch(() => {});
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  /**
   * Run a single match between two bots by opening page with parameters.
   */
  async runMatch(topBotId, bottomBotId, matchMeta = {}) {
    await this.ensureBrowser();

    const matchId = `match_${Date.now()}_${topBotId}_vs_${bottomBotId}`;
    const startTime = new Date();

    console.log(`[MatchRunner] === Starting match ${topBotId} vs ${bottomBotId} (id: ${matchId}) ===`);
    console.log(`[MatchRunner] Using server port: ${this.localServerPort}`);

    // Create a fresh page for isolation
    const page = await this.context.newPage();
    this.page = page;

    // Attach diagnostics
    page.on('console', msg => {
      console.log(`[BROWSER:${msg.type().toUpperCase()}] ${msg.text()}`);
    });

    page.on('pageerror', err => {
      console.error(`[BROWSER PAGEERROR] ${err.message}`);
    });

    // Install the result hook BEFORE the page loads
    await this.context.addInitScript(() => {
      window.__matchResult = null;
      window.gameCore = {
        gameState: null,
        endGame: (playerWon, reason) => {
          try {
            const gs = window.gameCore.gameState || {};
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
            window.__matchResult = { winnerSide: playerWon === 'draw' ? 'draw' : (playerWon ? 'bottom' : 'top'), reason: 'hook_error' };
          }
        }
      };
    });

    let gameResult = null;

    // Navigate to local server with championship parameters
    const gameUrl = `http://localhost:${this.localServerPort}/?championship=true&top=${topBotId}&bottom=${bottomBotId}&speed=${this.accelerate ? 15 : 1}`;
    console.log(`[MatchRunner] Navigating to ${gameUrl}`);

    try {
      await page.goto(gameUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (navErr) {
      console.error(`[MatchRunner] Navigation failed:`, navErr.message);
    }

    // Wait for the result hook to fire
    console.log(`[MatchRunner] Waiting for match result (timeout ${this.timeout}ms)...`);
    try {
      await page.waitForFunction(() => {
        return window.__matchResult !== null
            || (typeof window.gameCore !== 'undefined'
                && window.gameCore.gameState
                && window.gameCore.gameState.gameOver === true);
      }, null, { timeout: this.timeout });

      gameResult = await page.evaluate(() => {
        const state = (typeof window.gameCore !== 'undefined' && window.gameCore.gameState) || {};
        const hooked = window.__matchResult;
        return {
          gameOver: true,
          phase: state.phase,
          topBotId: state.topBotId,
          bottomBotId: state.bottomBotId,
          winnerSide: hooked ? hooked.winnerSide : (state.winner === 'draw' ? 'draw' : (state.winner === 'player' ? 'bottom' : 'top')),
          reason: hooked ? hooked.reason : state.endReason,
          topPieceCount: hooked ? hooked.topPieceCount : (state.aiPieces || []).filter(p => !p.removed).length,
          bottomPieceCount: hooked ? hooked.bottomPieceCount : (state.playerPieces || []).filter(p => !p.removed).length,
          totalMoves: hooked ? hooked.totalMoves : null
        };
      });

      await page.waitForTimeout(200);
    } catch (err) {
      console.error(`[MatchRunner] Match timed out:`, err.message);
      
      const shotDir = this.resultsDir;
      if (!fs.existsSync(shotDir)) {
        fs.mkdirSync(shotDir, { recursive: true });
      }
      const failShot = path.join(shotDir, `${matchId}_TIMEOUT.png`);
      await page.screenshot({ path: failShot, fullPage: true }).catch(() => {});
      
      gameResult = { gameOver: false, error: err.message, timedOut: true };
    }

    // Scrape battle logs from window.__battleLogs
    let finalBattleLog = [];
    try {
      finalBattleLog = await page.evaluate(() => {
        return (window.__battleLogs || []).map(msg => ({ message: msg }));
      });
    } catch (e) {
      console.warn('[MatchRunner] Failed to read logs from window:', e.message);
    }

    // Take final screenshot
    let screenshotPath = null;
    if (this.captureScreenshots && !gameResult.timedOut) {
      const shotDir = this.resultsDir;
      if (!fs.existsSync(shotDir)) {
        fs.mkdirSync(shotDir, { recursive: true });
      }
      screenshotPath = path.join(shotDir, `${matchId}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    }

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
      reason: gameResult ? (gameResult.reason || null) : null,
      totalMoves: gameResult ? (gameResult.totalMoves || null) : null,
      timedOut: !!(gameResult && gameResult.timedOut),
      result: gameResult,
      battleLog: finalBattleLog,
      screenshot: screenshotPath ? `screenshots/${matchId}.png` : null, // Relative web url path
      meta: matchMeta
    };

    // Determine winner string
    result.winner = 'draw';
    result.loser = null;
    
    if (gameResult && gameResult.winnerSide === 'top') {
      result.winner = 'top';
      result.loser = 'bottom';
    } else if (gameResult && gameResult.winnerSide === 'bottom') {
      result.winner = 'bottom';
      result.loser = 'top';
    }

    console.log(`[MatchRunner] Match ${matchId} finished. Winner: ${result.winner}, duration: ${result.durationSec}s`);
    await page.close().catch(() => {});

    return result;
  }
}

export default MatchRunner;
