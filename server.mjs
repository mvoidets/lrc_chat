import { createServer } from 'node:http';
import next from 'next';
import { Server } from 'socket.io';
import pkg from 'pg';
const { Client } = pkg;

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOSTNAME || 'localhost';
const port = process.env.PORT || '3005';

// Database client initialization
const client = new Client({
    connectionString: process.env.DATABASE_URL,
});

client.connect().then(() => {
    console.log('Connected to PostgreSQL database');
}).catch((error) => {
    console.error('Failed to connect to PostgreSQL:', error);
});
// Test query to check if DB is responding
const testDBConnection = async () => {
    try {
        await client.query('SELECT NOW()');
        console.log('Database is responding to queries');
    } catch (error) {
        console.error('Error executing test query:', error.message);
    }
};
client.query('SELECT NOW()')
    .then(() => {
        console.log('Database is responding to queries');
    })
    .catch((error) => {
        console.error('Error executing test query:', error.message);
    });

// Fetch available rooms from DB
const getRoomsFromDB = async () => {
    try {
        const res = await client.query('SELECT name FROM rooms');
        console.log('Rooms from DB:', res.rows.map(row => row.name));  // Log after the query
        return res.rows.map(row => row.name);
        
    } catch (error) {
        console.error('Error fetching rooms from DB:', error);
        return [];
    }
};

// Handle room creation
const createRoomInDB = async (newRoom) => {
    try {
        const checkRes = await client.query('SELECT * FROM rooms WHERE name = $1', [newRoom]);
        if (checkRes.rows.length > 0) return null;
        await client.query('INSERT INTO rooms (name) VALUES ($1) RETURNING *', [newRoom]);
        return newRoom;
    } catch (error) {
        console.error('Error creating room in DB:', error);
        return null;
    }
};

// Save message to the database
const saveMessageToDatabase = async (room, message, sender) => {
    try {
        const res = await client.query('INSERT INTO messages (room_name, message, sender) VALUES ($1, $2, $3) RETURNING *', [room, message, sender]);
        console.log('Message saved to DB:', res.rows[0]);
    } catch (error) {
        console.error('Error saving message to DB:', error);
    }
};
client.on('error', (error) => {
    console.error('Database client error:', error);
    // Try to reconnect if needed
    client.connect()
        .then(() => {
            console.log('Reconnected to PostgreSQL database');
        })
        .catch((error) => {
            console.error('Failed to reconnect to PostgreSQL:', error);
        });
});

// Get message history
export async function getMessagesFromDB(roomName) {
    try {
        const res = await client.query(
            'SELECT sender, message, created_at FROM messages WHERE room_name = $1 ORDER BY created_at ASC',
            [roomName]
        );
        return res.rows;
    } catch (error) {
        console.error('Error fetching messages from DB:', error);
        return [];
    }
};

// Dice rolling logic
const rollDice = (chips) => {
    const rollResults = [];
    for (let i = 0; i < chips; i++) {
        rollResults.push(Math.floor(Math.random() * 6) + 1);
    }
    return rollResults;
};

// Process dice roll results and update player state
const processDiceResults = async (diceResults, playerId, roomId) => {
    try {
        const totalRoll = diceResults.reduce((sum, roll) => sum + roll, 0);
        const updatedPlayers = await updatePlayerChips(playerId, totalRoll, roomId);
        return updatedPlayers;
    } catch (error) {
        throw error;
    }
};

// Update player chips in the database
const updatePlayerChips = async (playerId, totalRoll, room) => {
    try {
        const { rows: players } = await client.query(
            'SELECT * FROM players WHERE room_id = $1',
            [room]
        );

        const updatedPlayers = players.map(player => {
            if (player.id === playerId) {
                player.chips -= totalRoll; // Adjust based on your game rules
            }
            return player;
        });

        // Update the database
        for (let player of updatedPlayers) {
            await client.query(
                'UPDATE players SET chips = $1 WHERE id = $2',
                [player.chips, player.id]
            );
        }

        return updatedPlayers;
    } catch (error) {
        console.error('Error updating player chips:', error);
        throw error;
    }
};

// Socket event handling
const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
    const httpServer = createServer(handle);
    const io = new Server(httpServer, {
        cors: {
            origin: "*",
            methods: ["GET", "POST"],
            allowedHeaders: ["Content-Type"],
            credentials: true,
        },
        pingInterval: 25000,  // Send ping every 25 seconds
        pingTimeout: 60000,   // Timeout if no pong response in 60 seconds
    });

    io.on('connection', (socket) => {
        console.log(`A player connected: ${socket.id}`);

        // Handle the 'join-room' event
        socket.on('join-room', async ({ room, userName }) => {
       console.log(`Received join-room event for user: ${userName}, room: ${room}`);
    if (!userName) {
        console.error("Error: userName is undefined when joining room");
        return;
    }

    try {
        socket.join(room);

        // Fetch and emit message history for the room
        const messages = await getMessagesFromDB(room);
        socket.emit('messageHistory', messages, room);  // Emit message history for the specific room
        
        // Emit system message for the user joining
        io.to(room).emit('user_joined', `${userName} has joined the room: ${room}`, room);
    } catch (error) {
        console.error('Error in join-room handler:', error);
    }
});


        // Handle room creation
        socket.on('createRoom', async (newRoom) => {
            try {
                // Check if room already exists
                const checkRes = await client.query('SELECT * FROM rooms WHERE name = $1', [newRoom]);
        
                if (checkRes.rows.length > 0) {
                    console.log('Room already exists');
                    // Emit failure response to client
                    socket.emit('createRoomResponse', { success: false, error: 'Room already exists' });
                    return;
                }
        
                // Create the new room in the database
                const res = await client.query('INSERT INTO rooms (name) VALUES ($1) RETURNING *', [newRoom]);
                console.log(`Room created: ${newRoom}`);
        
                // Emit success response to the client
                socket.emit('createRoomResponse', { success: true, room: newRoom });
        
                // Emit the updated available rooms to all clients
                io.emit('availableRooms', await getRoomsFromDB());
            } catch (error) {
                console.error('Error creating room:', error);
                // Emit error response to client
                socket.emit('createRoomResponse', { success: false, error: 'Error creating room' });
            }
        });

        // Handle fetching available rooms
        socket.on('get-available-rooms', async () => {
            try {
                const rooms = await getRoomsFromDB();
                io.emit('availableRooms', rooms);
                console.log(`Available rooms: ${rooms}`);
            } catch (error) {
                console.error('Error fetching available rooms:', error);
            }
        });

        // Handle leave-room event
        socket.on('leave-room', (room, userName) => {
            console.log(`User: ${userName}, has left the room: ${room}`);
            socket.leave(room);
            socket.to(room).emit('user_left', `${userName} has left the room`);
        });

        // Handle removeRoom event
        socket.on("removeRoom", async (roomToRemove) => {
            console.log(`Removing room: ${roomToRemove}`);

            try {
                await client.query('DELETE FROM messages WHERE room_name = $1', [roomToRemove]);
                await client.query('DELETE FROM rooms WHERE name = $1', [roomToRemove]);
        
                // Emit updated room list to clients after deletion
                const updatedRooms = await getRoomsFromDB();
                io.emit("availableRooms", updatedRooms);  // Emit updated room list
            } catch (error) {
                console.error("Error deleting room and messages:", error);
            }
        });

        // Handle message event (sending messages in rooms)
       // Handle message event (sending messages in rooms)
        socket.on('message', async ({ room, message, sender }) => {
            console.log(`Sending message to room: ${room}, Message: ${message}`);
            console.log(`Message received from ${sender} in room ${room}: ${message}`);
        
            // Check for missing data early on
            if (!room || !message || !sender) {
            console.error("Missing information in message event.");
            return;
            }
        
            try {
            // Save the message to the database
            await saveMessageToDatabase(room, sender, message);
        
            // Emit the new message to the room
            io.to(room).emit('newMessage', { sender, message,room });
            } catch (error) {
            console.error('Error saving message to DB:', error);
            }
        });
        socket.on("get-message-history", async (room) => {
            // Query your database to fetch the message history for this room
            const history = await getMessageHistoryFromDatabase(room);
            
            // Emit the message history back to the client
            socket.emit("messageHistory", history, room);
          });
          
        

    }); // <-- Closing brace here

    // Start the server
    httpServer.listen(port, '0.0.0.0', () => {
        console.log(`Server listening on http://${hostname}:${port}`);
    });
}).catch((err) => {
    console.error('Error preparing app:', err);
});
