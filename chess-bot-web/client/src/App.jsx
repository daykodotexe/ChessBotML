import { useState, useRef } from 'react'
import { Chess } from 'chess.js'
import { Chessboard } from 'react-chessboard'
import axios from 'axios'
import './App.css'

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

function App() {
  const [screen, setScreen] = useState('select')
  const [playerColor, setPlayerColor] = useState('white')
  const [fen, setFen] = useState(INITIAL_FEN)
  const [status, setStatus] = useState('')
  const [isBotThinking, setIsBotThinking] = useState(false)
  const [gameOver, setGameOver] = useState(false)

  const gameRef = useRef(new Chess())

  const refreshStatus = (game, color) => {
    const activeColor = color ?? playerColor
    if (game.isCheckmate()) {
      setStatus(game.turn() === 'w' ? 'Checkmate! Black wins.' : 'Checkmate! White wins.')
      setGameOver(true)
    } else if (game.isStalemate()) {
      setStatus('Stalemate.')
      setGameOver(true)
    } else if (game.isInsufficientMaterial()) {
      setStatus('Draw by insufficient material.')
      setGameOver(true)
    } else if (game.isThreefoldRepetition()) {
      setStatus('Draw by threefold repetition.')
      setGameOver(true)
    } else if (game.isDraw()) {
      setStatus('Draw.')
      setGameOver(true)
    } else {
      const isPlayerTurn =
        (activeColor === 'white' && game.turn() === 'w') ||
        (activeColor === 'black' && game.turn() === 'b')
      setStatus(isPlayerTurn ? 'Your move.' : 'Bot thinking...')
    }
  }

  const requestBotMove = async (currentFen, color) => {
    try {
      setIsBotThinking(true)
      const response = await axios.post('http://localhost:3001/move', { fen: currentFen })
      const { move, gameOver: serverGameOver } = response.data

      const game = gameRef.current

      if (!move || serverGameOver) {
        setGameOver(true)
        refreshStatus(game, color)
        return
      }

      const from = move.slice(0, 2)
      const to = move.slice(2, 4)
      const promotion = move.length > 4 ? move.slice(4) : undefined

      const applied = game.move({ from, to, promotion })
      if (!applied) {
        console.warn('Server suggested illegal move, ignoring.')
        refreshStatus(game, color)
        return
      }

      setFen(game.fen())
      refreshStatus(game, color)
    } catch (err) {
      console.error('Error calling /move:', err)
      setStatus('Error talking to bot server.')
    } finally {
      setIsBotThinking(false)
    }
  }

  const onDrop = async ({ sourceSquare, targetSquare }) => {
    if (isBotThinking || gameOver) return false

    const game = gameRef.current
    const move = game.move({ from: sourceSquare, to: targetSquare, promotion: 'q' })
    if (move == null) return false

    setFen(game.fen())
    refreshStatus(game)

    if (!game.isGameOver()) {
      await requestBotMove(game.fen())
    }

    return true
  }

  const startGame = async (color) => {
    const game = new Chess()
    gameRef.current = game
    setPlayerColor(color)
    setFen(INITIAL_FEN)
    setGameOver(false)
    setIsBotThinking(false)
    setStatus(color === 'white' ? 'Your move.' : 'Bot thinking...')
    setScreen('playing')

    if (color === 'black') {
      await requestBotMove(game.fen(), color)
    }
  }

  const onReset = () => {
    gameRef.current = new Chess()
    setFen(INITIAL_FEN)
    setGameOver(false)
    setIsBotThinking(false)
    setStatus('')
    setScreen('select')
  }

  const onNewGame = () => {
    const game = new Chess()
    gameRef.current = game
    setFen(INITIAL_FEN)
    setGameOver(false)
    setIsBotThinking(false)
    setStatus(playerColor === 'white' ? 'Your move.' : 'Bot thinking...')
    if (playerColor === 'black') requestBotMove(game.fen(), playerColor)
  }

  if (screen === 'select') {
    return (
      <div className="app-container">
        <h1>Chess Style Bot</h1>
        <div className="color-select">
          <p>Play as...</p>
          <div className="color-buttons">
            <button className="color-btn white-btn" onClick={() => startGame('white')}>
              ♔ White
            </button>
            <button className="color-btn black-btn" onClick={() => startGame('black')}>
              ♚ Black
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="app-container">
      <h1>Chess Style Bot</h1>
      <div className="board-wrapper">
        <Chessboard
          options={{
            position: fen,
            onPieceDrop: onDrop,
            boardOrientation: playerColor,
          }}
        />
      </div>
      <div className="controls">
        <p className="status-text">{status}</p>
        <div className="button-row">
          <button onClick={onReset} disabled={isBotThinking}>↩ Change Color</button>
          <button onClick={onNewGame} disabled={isBotThinking}>↺ New Game</button>
        </div>
      </div>
    </div>
  )
}

export default App
