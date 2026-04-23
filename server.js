const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static(path.join(__dirname, 'public')));

let players = [];
let gameStarted = false;
let currentTurn = 0;
let chamber = 0;
let startInitiator = null;

function initGame() {
    if (players.length < 1) return;
    gameStarted = true;
    currentTurn = 0;
    chamber = Math.floor(Math.random() * 6);
    io.emit('game-start', {
        players: players.map(p => p.name),
        firstTurn: players[0].id
    });
    io.emit('turn-update', { playerId: players[0].id });
}

function nextTurn() {
    if (!gameStarted) return;
    currentTurn = (currentTurn + 1) % players.length;
    io.emit('turn-update', { playerId: players[currentTurn].id });
}

function shoot(playerId) {
    const player = players.find(p => p.id === playerId);
    if (!player || !gameStarted || players[currentTurn].id !== playerId) return false;

    const isDead = chamber === 0;
    io.emit('shot-fired', { playerId, isDead });

    if (isDead) {
        players = players.filter(p => p.id !== playerId);
        io.emit('player-dead', { playerId, playersLeft: players.map(p => p.name) });

        if (players.length <= 1) {
            const winner = players.length === 1 ? players[0].name : null;
            io.emit('game-over', { winner });
            gameStarted = false;
            startInitiator = null;
            return true;
        }
        if (currentTurn >= players.length) currentTurn = 0;
        io.emit('turn-update', { playerId: players[currentTurn].id });
        chamber = Math.floor(Math.random() * 6);
        return true;
    } else {
        chamber = (chamber + 1) % 6;
        nextTurn();
        return true;
    }
}

io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);

    socket.on('join-game', (name) => {
        if (gameStarted) {
            socket.emit('error', 'Game already started');
            return;
        }
        if (players.length >= 6) {
            socket.emit('error', 'Game is full');
            return;
        }
        if (players.some(p => p.name === name)) {
            socket.emit('error', 'Name already taken');
            return;
        }
        players.push({ id: socket.id, name: name.slice(0, 20) });
        socket.emit('joined-success', { playerName: name });
        io.emit('players-update', { players: players.map(p => p.name) });
        console.log('Players:', players.map(p => p.name));

        if (players.length === 1) {
            socket.emit('can-start', true);
        }
    });

    socket.on('start-game', () => {
        if (gameStarted) return;
        if (players.length < 1) {
            socket.emit('error', 'Need at least 1 player');
            return;
        }
        initGame();
    });

    socket.on('shoot', () => {
        shoot(socket.id);
    });

    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);
        players = players.filter(p => p.id !== socket.id);
        io.emit('players-update', { players: players.map(p => p.name) });
        if (gameStarted && players.length < 2) {
            io.emit('game-over', { winner: players.length ? players[0].name : null });
            gameStarted = false;
            startInitiator = null;
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});