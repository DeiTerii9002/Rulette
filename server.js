const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

let rooms = {};
let activeUsers = {};

function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function broadcastRooms() {
    const list = Object.values(rooms).map(room => ({
        id: room.id,
        playerCount: room.players.length,
        inGame: room.gameStarted
    }));
    io.emit('rooms-list', list);
}

io.on('connection', (socket) => {
    let currentUser = null;
    let currentRoom = null;

    socket.on('login', ({ username }) => {
        if (activeUsers[username]) {
            socket.emit('login-failed', 'Этот аккаунт уже используется');
            return;
        }
        currentUser = username;
        activeUsers[username] = socket.id;
        socket.emit('login-success', username);
        broadcastRooms();
    });

    socket.on('create-room', () => {
        if (!currentUser) return;
        if (currentRoom) return;
        const roomId = generateRoomId();
        rooms[roomId] = {
            id: roomId,
            players: [{ id: socket.id, name: currentUser, isCreator: true }],
            gameStarted: false,
            currentTurn: 0,
            chamber: 0
        };
        currentRoom = roomId;
        socket.join(roomId);
        socket.emit('room-created', roomId);
        broadcastRooms();
    });

    socket.on('join-room', (roomId) => {
        if (!currentUser) return;
        if (currentRoom) return;
        const room = rooms[roomId];
        if (!room) return socket.emit('error', 'Комната не найдена');
        if (room.gameStarted) return socket.emit('error', 'Игра уже началась');
        if (room.players.length >= 6) return socket.emit('error', 'Комната полна');
        room.players.push({ id: socket.id, name: currentUser, isCreator: false });
        currentRoom = roomId;
        socket.join(roomId);
        socket.emit('joined-room', roomId);
        io.to(roomId).emit('room-players', room.players);
        broadcastRooms();
    });

    socket.on('start-game', () => {
        const room = rooms[currentRoom];
        if (!room) return;
        if (room.players[0].id !== socket.id) return;
        if (room.gameStarted) return;
        room.gameStarted = true;
        room.currentTurn = 0;
        room.chamber = Math.floor(Math.random() * 6);
        io.to(currentRoom).emit('game-started', {
            players: room.players.map(p => ({ id: p.id, name: p.name })),
            firstPlayer: room.players[0].id
        });
    });

    socket.on('shoot', () => {
        const room = rooms[currentRoom];
        if (!room || !room.gameStarted) return;
        if (room.players[room.currentTurn].id !== socket.id) return;
        const isDead = room.chamber === 0;
        io.to(currentRoom).emit('shot-result', { playerId: socket.id, dead: isDead });
        if (isDead) {
            const index = room.players.findIndex(p => p.id === socket.id);
            room.players.splice(index, 1);
            io.to(currentRoom).emit('player-died', { players: room.players });
            if (room.players.length <= 1) {
                const winner = room.players.length === 1 ? room.players[0].name : null;
                io.to(currentRoom).emit('game-over', { winner });
                delete rooms[currentRoom];
                currentRoom = null;
                broadcastRooms();
                return;
            }
            if (room.currentTurn >= room.players.length) room.currentTurn = 0;
            io.to(currentRoom).emit('turn-change', { playerId: room.players[room.currentTurn].id });
            room.chamber = Math.floor(Math.random() * 6);
        } else {
            room.chamber = (room.chamber + 1) % 6;
            room.currentTurn = (room.currentTurn + 1) % room.players.length;
            io.to(currentRoom).emit('turn-change', { playerId: room.players[room.currentTurn].id });
        }
    });

    socket.on('leave-room', () => {
        if (!currentRoom) return;
        const room = rooms[currentRoom];
        if (room) {
            const idx = room.players.findIndex(p => p.id === socket.id);
            if (idx !== -1) room.players.splice(idx, 1);
            if (room.players.length === 0) delete rooms[currentRoom];
            else io.to(currentRoom).emit('room-players', room.players);
            broadcastRooms();
        }
        socket.leave(currentRoom);
        currentRoom = null;
        socket.emit('left-room');
    });

    socket.on('logout', () => {
        if (currentUser && activeUsers[currentUser] === socket.id) delete activeUsers[currentUser];
        if (currentRoom) socket.emit('leave-room');
        socket.emit('logged-out');
    });

    socket.on('disconnect', () => {
        if (currentUser && activeUsers[currentUser] === socket.id) delete activeUsers[currentUser];
        if (currentRoom) {
            const room = rooms[currentRoom];
            if (room) {
                const idx = room.players.findIndex(p => p.id === socket.id);
                if (idx !== -1) room.players.splice(idx, 1);
                if (room.players.length === 0) delete rooms[currentRoom];
                else io.to(currentRoom).emit('room-players', room.players);
                broadcastRooms();
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`✅ Server on port ${PORT}`));