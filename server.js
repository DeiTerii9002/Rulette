const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static(path.join(__dirname, 'public')));

let rooms = {};

function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('create-room', (playerName) => {
        const roomId = generateRoomId();
        rooms[roomId] = {
            id: roomId,
            players: [{ id: socket.id, name: playerName, isCreator: true }],
            gameStarted: false,
            currentTurn: 0,
            chamber: 0
        };
        socket.join(roomId);
        socket.emit('room-created', { roomId, players: rooms[roomId].players });
        io.emit('update-rooms', getRoomsList());
    });

    socket.on('join-room', ({ roomId, playerName }) => {
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
        if (room.players.some(p => p.name === playerName)) {
            socket.emit('error', 'Name already taken in this room');
            return;
        }
        room.players.push({ id: socket.id, name: playerName, isCreator: false });
        socket.join(roomId);
        io.to(roomId).emit('players-update', room.players);
        io.emit('update-rooms', getRoomsList());
    });

    socket.on('start-game', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player || !player.isCreator) {
            socket.emit('error', 'Only room creator can start the game');
            return;
        }
        if (room.gameStarted) return;
        if (room.players.length < 1) return;
        
        room.gameStarted = true;
        room.currentTurn = 0;
        room.chamber = Math.floor(Math.random() * 6);
        
        io.to(roomId).emit('game-start', {
            players: room.players.map(p => ({ id: p.id, name: p.name })),
            firstPlayerId: room.players[0].id
        });
    });

    socket.on('shoot', (roomId) => {
        const room = rooms[roomId];
        if (!room || !room.gameStarted) return;
        if (room.players[room.currentTurn].id !== socket.id) return;
        
        const isDead = room.chamber === 0;
        io.to(roomId).emit('shot-fired', { playerId: socket.id, isDead });
        
        if (isDead) {
            const deadIndex = room.players.findIndex(p => p.id === socket.id);
            room.players.splice(deadIndex, 1);
            io.to(roomId).emit('player-dead', { 
                playerId: socket.id, 
                playersLeft: room.players.map(p => ({ id: p.id, name: p.name })),
                currentTurnId: room.players.length > 0 ? room.players[room.currentTurn >= room.players.length ? 0 : room.currentTurn].id : null
            });
            
            if (room.players.length <= 1) {
                const winner = room.players.length === 1 ? room.players[0].name : null;
                io.to(roomId).emit('game-over', { winner });
                delete rooms[roomId];
                io.emit('update-rooms', getRoomsList());
                return;
            }
            if (room.currentTurn >= room.players.length) room.currentTurn = 0;
            io.to(roomId).emit('turn-update', { playerId: room.players[room.currentTurn].id });
            room.chamber = Math.floor(Math.random() * 6);
        } else {
            room.chamber = (room.chamber + 1) % 6;
            room.currentTurn = (room.currentTurn + 1) % room.players.length;
            io.to(roomId).emit('turn-update', { playerId: room.players[room.currentTurn].id });
        }
    });

    socket.on('disconnect', () => {
        for (let roomId in rooms) {
            const room = rooms[roomId];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                room.players.splice(playerIndex, 1);
                io.to(roomId).emit('players-update', room.players);
                if (room.players.length === 0) {
                    delete rooms[roomId];
                } else if (room.gameStarted && room.players.length < 2) {
                    io.to(roomId).emit('game-over', { winner: room.players.length ? room.players[0].name : null });
                    delete rooms[roomId];
                } else if (room.gameStarted && room.currentTurn >= room.players.length) {
                    room.currentTurn = 0;
                    io.to(roomId).emit('turn-update', { playerId: room.players[0].id });
                }
                io.emit('update-rooms', getRoomsList());
                break;
            }
        }
    });
});

function getRoomsList() {
    return Object.values(rooms).map(room => ({
        id: room.id,
        playerCount: room.players.length,
        inGame: room.gameStarted
    }));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server on port ${PORT}`));