import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Chess } from 'chess.js';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Style model ────────────────────────────────────────────────────────────────
const modelPath = path.join(__dirname, 'style_model.json');
let coef = [];
let intercept = 0;

try {
  const raw = fs.readFileSync(modelPath, 'utf-8');
  const styleModel = JSON.parse(raw);
  coef = styleModel.coef || [];
  intercept = styleModel.intercept || 0;
  if (!Array.isArray(coef) || coef.length !== 902) {
    console.warn(`Warning: expected 902 coef but got ${Array.isArray(coef) ? coef.length : 'invalid'}`);
  } else {
    console.log('Style model loaded OK');
  }
} catch (err) {
  console.error('Failed to load style_model.json — bot falls back to random.', err.message);
}

// ── Stockfish ──────────────────────────────────────────────────────────────────
// How much Stockfish score influences move choice (0 = pure style, 1 = pure engine)
// 0.4 is a good balance — plays real chess but keeps the personal style feel
const STOCKFISH_WEIGHT = 0.4;
const STOCKFISH_DEPTH  = 10;  // increase for stronger play (12-14 is very strong)

// Path to stockfish binary — tries common locations
const STOCKFISH_PATHS = [
  path.join(__dirname, 'stockfish'),
  path.join(__dirname, 'stockfish.exe'),
  '/usr/bin/stockfish',
  '/usr/local/bin/stockfish',
  'stockfish',
];

function findStockfish() {
  for (const p of STOCKFISH_PATHS) {
    try {
      if (p === 'stockfish' || fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

const STOCKFISH_PATH = findStockfish();
if (STOCKFISH_PATH) {
  console.log('Stockfish found at:', STOCKFISH_PATH);
} else {
  console.warn('Stockfish not found — bot will use style model only (weaker).');
}

// Evaluate all legal moves from a FEN using Stockfish
// Returns a Map of uci_move -> centipawn score (from the side to move's perspective)
function evaluateMoves(fen, moves, depth) {
  return new Promise((resolve) => {
    if (!STOCKFISH_PATH || !moves.length) {
      resolve(new Map());
      return;
    }

    let sf;
    try {
      sf = spawn(STOCKFISH_PATH, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      resolve(new Map());
      return;
    }

    const scores = new Map();
    let buffer = '';
    let currentMove = null;
    let moveQueue = [...moves];
    let done = false;

    const timeout = setTimeout(() => {
      if (!done) {
        done = true;
        try { sf.kill(); } catch {}
        resolve(scores);
      }
    }, 3000); // 3s max total

    const sendNext = () => {
      if (!moveQueue.length) {
        done = true;
        clearTimeout(timeout);
        try { sf.stdin.write('quit\n'); } catch {}
        resolve(scores);
        return;
      }
      currentMove = moveQueue.shift();
      // Make the move on a temp board to get the resulting position
      const tempChess = new Chess(fen);
      const from = currentMove.slice(0, 2);
      const to   = currentMove.slice(2, 4);
      const promo = currentMove.length > 4 ? currentMove[4] : undefined;
      try {
        tempChess.move({ from, to, promotion: promo });
      } catch {
        sendNext();
        return;
      }
      const newFen = tempChess.fen();
      sf.stdin.write(`position fen ${newFen}\n`);
      sf.stdin.write(`go depth ${depth}\n`);
    };

    sf.stdout.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith('info') && line.includes(' score ')) {
          const cpMatch = line.match(/score cp (-?\d+)/);
          const mateMatch = line.match(/score mate (-?\d+)/);
          if (cpMatch) {
            // Score is from the perspective of the side to move AFTER the move,
            // so negate it to get score from original side's perspective
            scores.set(currentMove, -parseInt(cpMatch[1], 10));
          } else if (mateMatch) {
            const m = parseInt(mateMatch[1], 10);
            scores.set(currentMove, m > 0 ? -100000 : 100000);
          }
        }
        if (line.startsWith('bestmove')) {
          sendNext();
        }
      }
    });

    sf.on('error', () => {
      if (!done) { done = true; clearTimeout(timeout); resolve(scores); }
    });
    sf.on('close', () => {
      if (!done) { done = true; clearTimeout(timeout); resolve(scores); }
    });

    sf.stdin.write('uci\n');
    sf.stdin.write('isready\n');
    sf.stdout.once('data', () => { sendNext(); }); // wait for first response then start
  });
}

// ── Feature encoding (same as before) ─────────────────────────────────────────
const pieceOrder = ['P', 'N', 'B', 'R', 'Q', 'K', 'p', 'n', 'b', 'r', 'q', 'k'];

function encodeBoardAndTurn(fen) {
  const parts = fen.split(' ');
  const boardPart = parts[0];
  const turnChar  = parts[1] || 'w';
  const boardVec  = new Float64Array(768);
  let sq = 0;
  for (const rank of boardPart.split('/')) {
    for (const ch of rank) {
      if (/[1-8]/.test(ch)) { sq += Number(ch); }
      else {
        const idx = pieceOrder.indexOf(ch);
        if (idx !== -1 && sq < 64) boardVec[idx * 64 + sq] = 1;
        sq++;
      }
    }
  }
  return { boardVec, turnBit: turnChar === 'w' ? 1 : 0 };
}

function squareToIndex(sq) {
  if (!sq || sq.length !== 2) return 0;
  const file = sq.charCodeAt(0) - 97;
  const rank = Number(sq[1]);
  return (8 - rank) * 8 + file;
}

function scoreStyleMove(fen, move) {
  if (!coef.length) return 0;
  const { boardVec, turnBit } = encodeBoardAndTurn(fen);
  const x = new Float64Array(902);
  x.set(boardVec, 0);
  const fromIdx = squareToIndex(move.from);
  const toIdx   = squareToIndex(move.to);
  if (fromIdx < 64) x[768 + fromIdx] = 1;
  if (toIdx < 64)   x[832 + toIdx]   = 1;
  const promoMap = { n: 1, b: 2, r: 3, q: 4 };
  x[896 + (move.promotion ? promoMap[move.promotion] || 0 : 0)] = 1;
  x[901] = turnBit;
  let score = intercept;
  for (let i = 0; i < 902; i++) score += coef[i] * x[i];
  return score;
}

// ── History for repetition penalty ────────────────────────────────────────────
const fenHistory = [];
function getFenKey(fen) { return (fen || '').split(' ').slice(0, 4).join(' '); }
function updateFenHistory(key) {
  if (!key) return;
  fenHistory.push(key);
  if (fenHistory.length > 12) fenHistory.shift();
}

// ── Softmax sampling ──────────────────────────────────────────────────────────
function softmaxSample(candidates, temperature) {
  if (!candidates.length) return null;
  const temp = temperature > 0 ? temperature : 1.0;
  const max = Math.max(...candidates.map(c => c.score));
  const weights = candidates.map(c => Math.exp((c.score - max) / temp));
  const sum = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * sum;
  for (let i = 0; i < candidates.length; i++) {
    r -= weights[i];
    if (r <= 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

// ── Move selection ─────────────────────────────────────────────────────────────
async function chooseMove(chess) {
  const fen = chess.fen();
  const legalMoves = chess.moves({ verbose: true });
  if (!legalMoves.length) return null;

  // Get style scores for all moves
  const candidates = legalMoves.map(move => {
    let styleScore = scoreStyleMove(fen, move);
    // Repetition penalty
    const tempChess = new Chess(fen);
    tempChess.move({ from: move.from, to: move.to, promotion: move.promotion });
    const newKey = getFenKey(tempChess.fen());
    if (fenHistory.includes(newKey)) styleScore -= 0.25;
    return { move, styleScore, newKey, engineScore: 0 };
  });

  // Get Stockfish scores if available
  if (STOCKFISH_PATH) {
    const uciMoves = legalMoves.map(m => `${m.from}${m.to}${m.promotion || ''}`);
    const engineScores = await evaluateMoves(fen, uciMoves, STOCKFISH_DEPTH);

    if (engineScores.size > 0) {
      // Normalise engine scores to similar range as style scores
      const rawScores = [...engineScores.values()];
      const mean = rawScores.reduce((a, b) => a + b, 0) / rawScores.length;
      const std  = Math.sqrt(rawScores.map(v => (v - mean) ** 2).reduce((a, b) => a + b, 0) / rawScores.length) || 1;

      for (const c of candidates) {
        const uci = `${c.move.from}${c.move.to}${c.move.promotion || ''}`;
        const raw = engineScores.get(uci);
        if (raw !== undefined) {
          // Normalise then scale to style score range (~std 0.2)
          c.engineScore = ((raw - mean) / std) * 0.2;
        }
      }
    }
  }

  // Blend: final = style * (1 - weight) + engine * weight
  for (const c of candidates) {
    c.score = c.styleScore * (1 - STOCKFISH_WEIGHT) + c.engineScore * STOCKFISH_WEIGHT;
  }

  // Dynamic sampling params based on position complexity
  const n = legalMoves.length;
  const topK       = n >= 35 ? 8  : n <= 18 ? 4  : 6;
  const temperature = n >= 35 ? 1.1 : n <= 18 ? 0.7 : 0.9;
  const mistakeRate = n >= 35 ? 0.15 : n <= 18 ? 0.06 : 0.10;

  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const top    = sorted.slice(0, Math.min(topK, sorted.length));
  const mistakes = sorted.slice(5, Math.min(sorted.length, 14));

  if (mistakes.length && Math.random() < mistakeRate) {
    return softmaxSample(mistakes, temperature) || softmaxSample(top, temperature);
  }
  return softmaxSample(top, temperature);
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

app.post('/move', async (req, res) => {
  const { fen } = req.body || {};
  if (!fen) return res.status(400).json({ error: 'Missing fen' });

  let chess;
  try { chess = new Chess(fen); }
  catch { chess = new Chess(); }

  updateFenHistory(getFenKey(chess.fen()));

  if (chess.isGameOver()) return res.json({ move: null, gameOver: true });

  try {
    const choice = await chooseMove(chess);

    if (!choice || !choice.move) return res.json({ move: null, gameOver: true });

    const { move, newKey } = choice;
    chess.move({ from: move.from, to: move.to, promotion: move.promotion });
    updateFenHistory(newKey || getFenKey(chess.fen()));

    const uci = `${move.from}${move.to}${move.promotion || ''}`;
    return res.json({ move: uci, gameOver: chess.isGameOver() });
  } catch (err) {
    console.error('Error choosing move:', err.message);
    // Fallback: random legal move
    const moves = chess.moves({ verbose: true });
    if (!moves.length) return res.json({ move: null, gameOver: true });
    const m = moves[Math.floor(Math.random() * moves.length)];
    chess.move({ from: m.from, to: m.to, promotion: m.promotion });
    return res.json({ move: `${m.from}${m.to}${m.promotion || ''}`, gameOver: chess.isGameOver() });
  }
});

app.listen(3001, () => console.log('Chess style bot server listening on http://localhost:3001'));
