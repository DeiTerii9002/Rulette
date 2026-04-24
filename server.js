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
let userSessions = new Map(); // socketId -> { username, roomId }

function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function getRoomsList() {
    return Object.values(rooms).map(room => ({
        id: room.id,
        playerCount: room.players.length,
        inGame: room.gameStarted
    }));
}

io.on('connection', (socket) => {
    console.log('New connection:', socket.id);
    
    // Восстанавливаем пользователя, если он есть в сессиях
    if (userSessions.has(socket.id)) {
        const saved = userSessions.get(socket.id);
        socket.username = saved.username;
        socket.currentRoom = saved.roomId;
        console.log(`Restored user ${socket.username} for ${socket.id}`);
    }

    socket.on('set-user', (username) => {
        socket.username = username;
        userSessions.set(socket.id, { username, roomId: socket.currentRoom || null });
        console.log(`User ${username} set for ${socket.id}`);
        socket.emit('user-set', username);
    });

    socket.on('get-rooms', () => {
        socket.emit('rooms-list', getRoomsList());
    });

    socket.on('create-room', () => {
        if (!socket.username) {
            socket.emit('error', 'Not logged in');
            return;
        }
        if (socket.currentRoom) {
            socket.emit('error', 'You are already in a room');
            return;
        }
        const roomId = generateRoomId();
        rooms[roomId] = {
            id: roomId,
            players: [{ id: socket.id, name: socket.username, isCreator: true }],
            gameStarted: false,
            currentTurn: 0,
            chamber: 0
        };
        socket.currentRoom = roomId;
        userSessions.set(socket.id, { username: socket.username, roomId });
        socket.join(roomId);
        socket.emit('room-created', roomId);
        io.emit('rooms-list', getRoomsList());
        console.log(`Room ${roomId} created by ${socket.username}`);
    });

    socket.on('join-room', (roomId) => {
        if (!socket.username) {
            socket.emit('error', 'Not logged in');
            return;
        }
        if (socket.currentRoom) {
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
        if (room.players.some(p => p.name === socket.username)) {
            socket.emit('error', 'Already in this room');
            return;
        }
        room.players.push({ id: socket.id, name: socket.username, isCreator: false });
        socket.currentRoom = roomId;
        userSessions.set(socket.id, { username: socket.username, roomId });
        socket.join(roomId);
        socket.emit('joined-room', roomId);
        io.to(roomId).emit('room-players', room.players);
        io.emit('rooms-list', getRoomsList());
        console.log(`${socket.username} joined room ${roomId}`);
    });

    socket.on('start-game', () => {
        if (!socket.currentRoom) return;
        const room = rooms[socket.currentRoom];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player || !player.isCreator) {
            socket.emit('error', 'Only creator can start');
            return;
        }
        if (room.gameStarted) return;
        
        room.gameStarted = true;
        room.currentTurn = 0;
        room.chamber = Math.floor(Math.random() * 6);
        
        io.to(socket.currentRoom).emit('game-started', {
            players: room.players.map(p => ({ id: p.id, name: p.name })),
            firstPlayer: room.players[0].id
        });
    });

    socket.on('shoot', () => {
        if (!socket.currentRoom) return;
        const room = rooms[socket.currentRoom];
        if (!room || !room.gameStarted) return;
        if (room.players[room.currentTurn].id !== socket.id) return;
        
        const isDead = room.chamber === 0;
        io.to(socket.currentRoom).emit('shot-result', { player: socket.id, dead: isDead });
        
        if (isDead) {
            const index = room.players.findIndex(p => p.id === socket.id);
            room.players.splice(index, 1);
            io.to(socket.currentRoom).emit('player-left', { players: room.players.map(p => ({ id: p.id, name: p.name })) });
            
            if (room.players.length <= 1) {
                const winner = room.players.length === 1 ? room.players[0].name : null;
                io.to(socket.currentRoom).emit('game-ended', { winner });
                delete rooms[socket.currentRoom];
                socket.currentRoom = null;
                userSessions.set(socket.id, { username: socket.username, roomId: null });
                io.emit('rooms-list', getRoomsList());
                return;
            }
            if (room.currentTurn >= room.players.length) room.currentTurn = 0;
            io.to(socket.currentRoom).emit('turn-change', { player: room.players[room.currentTurn].id });
            room.chamber = Math.floor(Math.random() * 6);
        } else {
            room.chamber = (room.chamber + 1) % 6;
            room.currentTurn = (room.currentTurn + 1) % room.players.length;
            io.to(socket.currentRoom).emit('turn-change', { player: room.players[room.currentTurn].id });
        }
    });

    socket.on('leave-room', () => {
        if (!socket.currentRoom) return;
        const room = rooms[socket.currentRoom];
        if (room) {
            const index = room.players.findIndex(p => p.id === socket.id);
            if (index !== -1) room.players.splice(index, 1);
            if (room.players.length === 0) {
                delete rooms[socket.currentRoom];
            } else if (room.gameStarted) {
                io.to(socket.currentRoom).emit('game-ended', { winner: null });
                delete rooms[socket.currentRoom];
            } else {
                io.to(socket.currentRoom).emit('room-players', room.players);
            }
            io.emit('rooms-list', getRoomsList());
        }
        socket.leave(socket.currentRoom);
        socket.currentRoom = null;
        userSessions.set(socket.id, { username: socket.username, roomId: null });
        socket.emit('left-room');
    });

    socket.on('disconnect', () => {
        console.log('Disconnected:', socket.id);
        if (socket.currentRoom) {
            const room = rooms[socket.currentRoom];
            if (room) {
                const index = room.players.findIndex(p => p.id === socket.id);
                if (index !== -1) room.players.splice(index, 1);
                if (room.players.length === 0) {
                    delete rooms[socket.currentRoom];
                } else if (room.gameStarted) {
                    io.to(socket.currentRoom).emit('game-ended', { winner: null });
                    delete rooms[socket.currentRoom];
                } else {
                    io.to(socket.currentRoom).emit('room-players', room.players);
                }
                io.emit('rooms-list', getRoomsList());
            }
        }
        userSessions.delete(socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));