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

let rooms = {};

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
    console.log('✅ Client connected:', socket.id);
    
    let userName = null;
    let userRoom = null;

    socket.on('login', ({ username, password }) => {
        userName = username;
        console.log(`📌 User logged in: ${userName}`);
        socket.emit('login-success', userName);
        broadcastRooms();
    });

    socket.on('create-room', () => {
        if (userRoom) {
            socket.emit('error', 'You are already in a room');
            return;
        }
        const roomId = generateRoomId();
        rooms[roomId] = {
            id: roomId,
            creator: socket.id,
            creatorName: userName,
            players: [{ id: socket.id, name: userName, isCreator: true }],
            gameStarted: false,
            currentTurn: 0,
            chamber: Math.floor(Math.random() * 6)
        };
        userRoom = roomId;
        socket.join(roomId);
        socket.emit('room-created', roomId);
        broadcastRooms();
        console.log(`🏠 Room created: ${roomId} by ${userName}`);
    });

    socket.on('join-room', (roomId) => {
        if (userRoom) {
            socket.emit('error', 'You are already in a room');
            return;
        }
        const room = rooms[roomId];
        if (!room) {
            socket.emit('error', 'Room not found');
            return;
        }
        if (room.gameStarted) {
            socket.emit('error', 'Game already started');
            return;
        }
        if (room.players.length >= 6) {
            socket.emit('error', 'Room is full');
            return;
        }
        room.players.push({ id: socket.id, name: userName, isCreator: false });
        userRoom = roomId;
        socket.join(roomId);
        socket.emit('joined-room', roomId);
        io.to(roomId).emit('room-players', room.players);
        broadcastRooms();
        console.log(`👤 ${userName} joined room ${roomId}`);
    });

    socket.on('start-game', () => {
        const room = rooms[userRoom];
        if (!room) return;
        if (room.creator !== socket.id) {
            socket.emit('error', 'Only creator can start');
            return;
        }
        if (room.gameStarted) return;
        room.gameStarted = true;
        room.currentTurn = 0;
        room.chamber = Math.floor(Math.random() * 6);
        io.to(userRoom).emit('game-started', {
            players: room.players.map(p => ({ id: p.id, name: p.name })),
            firstPlayer: room.players[0].id
        });
        console.log(`🎮 Game started in room ${userRoom}`);
    });

    socket.on('shoot', () => {
        const room = rooms[userRoom];
        if (!room || !room.gameStarted) return;
        if (room.players[room.currentTurn].id !== socket.id) return;
        
        const isDead = room.chamber === 0;
        io.to(userRoom).emit('shot-result', { playerId: socket.id, dead: isDead });
        
        if (isDead) {
            const index = room.players.findIndex(p => p.id === socket.id);
            room.players.splice(index, 1);
            io.to(userRoom).emit('player-died', { 
                players: room.players.map(p => ({ id: p.id, name: p.name }))
            });
            
            if (room.players.length <= 1) {
                const winner = room.players.length === 1 ? room.players[0].name : null;
                io.to(userRoom).emit('game-over', { winner });
                delete rooms[userRoom];
                userRoom = null;
                broadcastRooms();
                return;
            }
            if (room.currentTurn >= room.players.length) room.currentTurn = 0;
            room.chamber = Math.floor(Math.random() * 6);
            io.to(userRoom).emit('turn-change', { playerId: room.players[room.currentTurn].id });
        } else {
            room.chamber = (room.chamber + 1) % 6;
            room.currentTurn = (room.currentTurn + 1) % room.players.length;
            io.to(userRoom).emit('turn-change', { playerId: room.players[room.currentTurn].id });
        }
    });

    socket.on('leave-room', () => {
        if (!userRoom) return;
        const room = rooms[userRoom];
        if (room) {
            const index = room.players.findIndex(p => p.id === socket.id);
            if (index !== -1) room.players.splice(index, 1);
            if (room.players.length === 0) {
                delete rooms[userRoom];
            } else if (room.gameStarted) {
                io.to(userRoom).emit('game-over', { winner: null });
                delete rooms[userRoom];
            } else {
                io.to(userRoom).emit('room-players', room.players);
            }
            socket.leave(userRoom);
            broadcastRooms();
        }
        userRoom = null;
        socket.emit('left-room');
    });

    socket.on('disconnect', () => {
        console.log(`❌ Client disconnected: ${socket.id} (${userName || 'unknown'})`);
        if (userRoom) {
            const room = rooms[userRoom];
            if (room) {
                const index = room.players.findIndex(p => p.id === socket.id);
                if (index !== -1) room.players.splice(index, 1);
                if (room.players.length === 0) {
                    delete rooms[userRoom];
                } else if (room.gameStarted) {
                    io.to(userRoom).emit('game-over', { winner: null });
                    delete rooms[userRoom];
                } else {
                    io.to(userRoom).emit('room-players', room.players);
                }
                broadcastRooms();
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server running on port ${PORT}`));