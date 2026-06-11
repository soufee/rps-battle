import { initGame, startGame, makeMove, makeChoice, makeBotMove, endTurn } from '../shared/game-core.js';
import { botRegistry } from '../shared/ai/index.js';
import { PLAYER, COMPUTER, GAME_CONFIG } from '../shared/game-config.js';

console.log("=== Testing Game Engine and Bot loading ===");
const bots = botRegistry.list();
console.log(`Successfully loaded ${bots.length} bots:`);
bots.forEach(b => console.log(` - ${b.id} (${b.name}, difficulty: ${b.difficultyLabel}, tier: ${b.tier})`));

// Let's test a game play simulation between player and rabbit
console.log("\n--- Starting game: player vs rabbit ---");
const state = initGame('rabbit');

// Placements
state.flagPosition = [5, 0];
state.trapPosition = [5, 1];
state.setupPhase = GAME_CONFIG.SETUP_PHASES.DONE;

// Start game
startGame(state);
console.log("Game started successfully. Current phase:", state.phase);
console.log("Player piece count:", state.playerPieces.length);
console.log("AI piece count:", state.aiPieces.length);

// Let's make a few random moves for player or auto bot move
let turn = 0;
while (!state.gameOver && turn < 50) {
    turn++;
    console.log(`\n--- Turn ${turn} ---`);
    if (state.currentPlayer === PLAYER) {
        // Player's turn: let's select a piece and make a random valid move
        let moved = false;
        // Import game-rules
        const { getValidMoves } = await import('../shared/game-rules.js');
        
        for (const piece of state.playerPieces) {
            if (piece.removed || piece.immobilized || piece.type === 'flag' || piece.type === 'trap') continue;
            const moves = getValidMoves(piece.row, piece.col, state.board, PLAYER);
            if (moves.length > 0) {
                const [tr, tc] = moves[0];
                console.log(`Player moves ${piece.type} from (${piece.row}, ${piece.col}) to (${tr}, ${tc})`);
                const res = makeMove(state, piece, tr, tc);
                console.log("Move result:", res.type, "result:", res.result);
                moved = true;
                
                // If it was a tie draw, make a choice to resolve it
                if (state.battleState) {
                    console.log("Tie battle state active. Resolving with rock choice.");
                    const resolveRes = makeChoice(state, 'rock');
                    console.log("Resolve result:", resolveRes.type);
                }
                
                // Flip player
                endTurn(state);
                break;
            }
        }
        if (!moved) {
            console.log("No valid moves for Player, ending.");
            break;
        }
    } else {
        // Bot's turn
        console.log("Bot (rabbit) makes a move...");
        const res = makeBotMove(state);
        console.log("Bot move result:", res.type);
        
        // If battle tie state active, resolve choice
        if (state.battleState) {
            console.log("Tie battle state active. Resolving with paper choice.");
            const resolveRes = makeChoice(state, 'paper');
            console.log("Resolve result:", resolveRes.type);
        }
    }
}

console.log("\n=== Simulation Finished ===");
console.log("Game Over:", state.gameOver);
console.log("Winner:", state.winner);
console.log("End Reason:", state.endReason);
process.exit(0);
