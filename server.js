const express = require("express");
const mysql = require("mysql2");
const bcrypt = require("bcrypt");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const WebSocket = require("ws");

const app = express();
app.use(express.json());
app.use(cors());

const SECRET_KEY = "your_secret_key"; // Change this to a strong secret in production

const db = mysql.createConnection({
    host: "localhost",
    user: "root",
    password: "MySQL15Dione",
    database: "ttt_db"
});

db.connect(err => {
    if (err) throw err;
    console.log("MySQL connected...");
});

// WebSocket Server
const wss = new WebSocket.Server({ noServer: true });

let waitingPlayers = [];
let activeGames = {}; // Store active games by game ID

// Handle WebSocket upgrade
app.server = app.listen(5000, () => {
    console.log("Server running on port 5000");
});
app.server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});

// WebSocket connection logic
wss.on('connection', (ws) => {
    console.log('New WebSocket connection');

    // Attach username to each connection
    ws.on('message', (message) => {
        const data = JSON.parse(message);

        if (data.action === 'join') {
            const username = data.username;
            ws.username = username; // Assign username to the socket

            // Prevent same user joining twice
            const alreadyWaiting = waitingPlayers.find(p => p.username === username);
            if (!alreadyWaiting) {
                waitingPlayers.push({ socket: ws, username });
                console.log(`${username} joined the queue`);
            }

            if (waitingPlayers.length >= 2) {
                const player1 = waitingPlayers.shift();
                const player2 = waitingPlayers.shift();

                const gameId = `${Date.now()}`; // Generate unique gameId using timestamp
                activeGames[gameId] = {
                    player1: player1.socket,
                    player2: player2.socket,
                    usernames: {
                        X: player1.username,
                        O: player2.username,
                    },
                    board: Array(9).fill(null),
                    currentPlayer: 'X'
                };

                // Send game start info to both players
                player1.socket.send(JSON.stringify({ action: 'startGame', gameId, symbol: 'X', board: activeGames[gameId].board, currentPlayer: 'X' }));
                player2.socket.send(JSON.stringify({ action: 'startGame', gameId, symbol: 'O', board: activeGames[gameId].board, currentPlayer: 'X' }));
            }
        }

        else if (data.action === 'move') {
            const { gameId, move, player } = data;
            const game = activeGames[gameId];

            if (game && game.currentPlayer === player && game.board[move] === null) {
                game.board[move] = player;
                game.currentPlayer = player === 'X' ? 'O' : 'X';

                const winner = checkWinner(game.board);
                if (winner) {
                    game.player1.send(JSON.stringify({ action: 'gameOver', winner }));
                    game.player2.send(JSON.stringify({ action: 'gameOver', winner }));
                    updateStats(game.usernames.X, winner === 'X' ? 'win' : 'loss');
                    updateStats(game.usernames.O, winner === 'O' ? 'win' : 'loss');
                    delete activeGames[gameId];
                } else if (game.board.every(cell => cell !== null)) {
                    game.player1.send(JSON.stringify({ action: 'gameOver', winner: 'Tie' }));
                    game.player2.send(JSON.stringify({ action: 'gameOver', winner: 'Tie' }));
                    updateStats(game.usernames.X, 'tie');
                    updateStats(game.usernames.O, 'tie');
                    delete activeGames[gameId];
                } else {
                    game.player1.send(JSON.stringify({ action: 'updateBoard', board: game.board, currentPlayer: game.currentPlayer }));
                    game.player2.send(JSON.stringify({ action: 'updateBoard', board: game.board, currentPlayer: game.currentPlayer }));
                }
            }
        }
    });

    ws.on('close', () => {
        console.log('WebSocket connection closed');
        // Remove closed player from waiting list
        waitingPlayers = waitingPlayers.filter(p => p.socket !== ws);
    });
});

// Helper function to check winner
function checkWinner(board) {
    const winPatterns = [
        [0, 1, 2], [3, 4, 5], [6, 7, 8],
        [0, 3, 6], [1, 4, 7], [2, 5, 8],
        [0, 4, 8], [2, 4, 6]
    ];
    for (let pattern of winPatterns) {
        if (board[pattern[0]] && board[pattern[0]] === board[pattern[1]] && board[pattern[0]] === board[pattern[2]]) {
            return board[pattern[0]]; // Return the winner ("X" or "O")
        }
    }
    return null;
}

// Register user
app.post("/register", async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ message: "All fields are required." });

    db.query("SELECT * FROM users WHERE username = ?", [username], async (err, result) => {
        if (err) return res.status(500).json({ message: "Database error." });
        if (result.length > 0) return res.status(400).json({ message: "Username is already taken." });

        const hashedPassword = await bcrypt.hash(password, 10);
        db.query("INSERT INTO users (username, password, wins, losses, ties) VALUES (?, ?, 0, 0, 0)", 
        [username, hashedPassword], 
        (err) => {
            if (err) return res.status(500).json({ message: "Error creating user." });
            res.json({ message: "Registration successful! You can now log in." });
        });
    });
});

// Login user
app.post("/login", (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ message: "All fields are required." });

    db.query("SELECT * FROM users WHERE username = ?", [username], async (err, result) => {
        if (err) return res.status(500).json({ message: "Database error." });
        if (result.length === 0) return res.status(400).json({ message: "User not found." });

        const user = result[0];
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ message: "Incorrect password." });

        const token = jwt.sign({ username: user.username }, SECRET_KEY, { expiresIn: "1h" });

        res.json({
            message: "Login successful!",
            token,
            username: user.username,
            stats: { wins: user.wins, losses: user.losses, ties: user.ties }
        });
    });
});

// Fetch user stats
app.get("/user-stats/:username", (req, res) => {
    const { username } = req.params;

    db.query("SELECT wins, losses, ties FROM users WHERE username = ?", [username], (err, result) => {
        if (err) return res.status(500).json({ message: "Database error." });
        if (result.length === 0) return res.status(404).json({ message: "User not found." });

        res.json(result[0]);
    });
});

// Update user stats (win/loss/tie)
function updateStats(username, result) {
    let query;
    if (result === 'win') {
        query = `UPDATE users SET wins = wins + 1 WHERE username = ?`;
    } else if (result === 'loss') {
        query = `UPDATE users SET losses = losses + 1 WHERE username = ?`;
    } else if (result === 'tie') {
        query = `UPDATE users SET ties = ties + 1 WHERE username = ?`;
    }

    db.query(query, [username], (err) => {
        if (err) throw err;
    });
}
