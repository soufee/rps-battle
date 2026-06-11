import prisma from '../models/db.js';

const RATING_WIN = 25;
const RATING_LOSE = -25;

const TOURNAMENT_LADDER_V1 = [
  'rabbit',
  'raccoon',
  'fox',
  'owl',
  'lion',
  'wolf',
  'hedgehog',
  'raven',
  'kimi_2_5',
  'codex_5_3_medium',
  'composer_2_5',
  'gemini_3_1_pro',
  'gemini_3_5_flash',
  'gpt_5_5',
  'grok_apex',
  'grok_build_0_1',
  'haiku_4_5',
  'opus_4_7_flash',
  'opus_4_8_high',
  'sonnet_4_6_medium'
];

const TOURNAMENT_LADDER_V2 = [
  'grok_build_0_1',
  'gemini_3_1_pro',
  'sonnet_4_6_medium',
  'haiku_4_5',
  'grok_apex',
  'rabbit',
  'kimi_2_5',
  'lion',
  'codex_5_3_medium',
  'raccoon',
  'raven',
  'fox',
  'gpt_5_5',
  'opus_4_8_high',
  'hedgehog',
  'wolf',
  'gemini_3_5_flash',
  'owl',
  'opus_4_7_flash',
  'composer_2_5'
];

function buildRatingDelta(result) {
  if (result === 'win') return RATING_WIN;
  if (result === 'lose') return RATING_LOSE;
  return 0;
}

function buildIncrements(result) {
  return {
    wins: result === 'win' ? 1 : 0,
    losses: result === 'lose' ? 1 : 0,
    draws: result === 'draw' ? 1 : 0
  };
}

/** Bot games: only BotOpponentStats — never touch MMR or PvP W/L. */
export async function updateStats(req, res) {
  const { result, botId } = req.body;
  if (!['win', 'lose', 'draw'].includes(result)) {
    return res.status(400).json({ error: 'Invalid result' });
  }

  if (!botId || typeof botId !== 'string' || botId.length === 0 || botId.length > 64) {
    return res.status(400).json({ error: 'botId is required for bot match stats' });
  }

  try {
    const userStats = await prisma.stats.findUnique({
      where: { userId: req.user.id }
    });
    if (!userStats) {
      return res.status(404).json({ error: 'Stats not found' });
    }

    const inc = buildIncrements(result);

    // Auto-transition stage 0 to version 2
    let tournamentVersion = userStats.tournamentVersion;
    if (userStats.tournamentStage === 0 && tournamentVersion !== 2) {
      tournamentVersion = 2;
    }

    const TOURNAMENT_LADDER = (tournamentVersion === 2)
      ? TOURNAMENT_LADDER_V2
      : TOURNAMENT_LADDER_V1;

    let advancedTournament = false;
    let newStage = userStats.tournamentStage;
    if (result === 'win') {
      const currentBotNeeded = TOURNAMENT_LADDER[userStats.tournamentStage];
      if (currentBotNeeded === botId) {
        newStage = userStats.tournamentStage + 1;
        advancedTournament = true;
      }
    }

    let updatedStats = userStats;
    if (advancedTournament || tournamentVersion !== userStats.tournamentVersion) {
      updatedStats = await prisma.stats.update({
        where: { userId: req.user.id },
        data: { 
          tournamentStage: newStage,
          tournamentVersion: tournamentVersion
        }
      });
    }

    const botRecord = await prisma.botOpponentStats.upsert({
      where: {
        userId_botId: { userId: req.user.id, botId }
      },
      create: {
        userId: req.user.id,
        botId,
        wins: inc.wins,
        losses: inc.losses,
        draws: inc.draws,
        gamesPlayed: 1,
        lastPlayedAt: new Date()
      },
      update: {
        wins: { increment: inc.wins },
        losses: { increment: inc.losses },
        draws: { increment: inc.draws },
        gamesPlayed: { increment: 1 },
        lastPlayedAt: new Date()
      }
    });

    res.json({
      success: true,
      stats: updatedStats,
      botRecord,
      advancedTournament,
      newStage
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

export async function getProfile(req, res) {
  try {
    let user = await prisma.user.findUnique({
      where: { id: req.user.id },
      include: {
        stats: true,
        botOpponentStats: {
          orderBy: [{ gamesPlayed: 'desc' }, { lastPlayedAt: 'desc' }]
        },
        pvpOpponentStats: {
          orderBy: [{ gamesPlayed: 'desc' }, { lastPlayedAt: 'desc' }],
          include: {
            opponent: {
              select: { id: true, nickname: true, avatarUrl: true }
            }
          }
        }
      }
    });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Auto-transition stage 0 to version 2
    if (user.stats && user.stats.tournamentStage === 0 && user.stats.tournamentVersion !== 2) {
      const updatedStats = await prisma.stats.update({
        where: { userId: user.id },
        data: { tournamentVersion: 2 }
      });
      user.stats = updatedStats;
    }

    res.json({
      user: {
        id: user.id,
        email: user.email,
        nickname: user.nickname,
        avatarUrl: user.avatarUrl,
        role: user.role,
        platform: user.platform,
        createdAt: user.createdAt,
        stats: user.stats,
        botOpponentStats: user.botOpponentStats,
        pvpOpponentStats: user.pvpOpponentStats
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

export async function resetTournament(req, res) {
  try {
    const updatedStats = await prisma.stats.update({
      where: { userId: req.user.id },
      data: { tournamentStage: 0, tournamentVersion: 2 }
    });
    res.json({ success: true, stats: updatedStats });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}