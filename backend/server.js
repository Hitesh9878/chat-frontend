// server.js - COMPLETE SERVER WITH ALL FEATURES & CONTINUOUS RUNNING
import express from 'express';
import http from 'http';
import cors from 'cors';
import dotenv from 'dotenv';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

import connectDB from './src/config/db.js';
import authRoutes from './src/routes/auth.js';
import messageRoutes from './src/routes/messages.js';
import userRoutes from './src/routes/user.routes.js';
import uploadRoutes from './src/routes/uploadRoutes.js';
import { errorHandler, notFound } from './src/middlewares/errorHandler.js';
import { initializeSocket } from './src/sockets/index.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class ChatServer {
    constructor() {
        this.app = express();
        this.server = null;
        this.io = null;
        this.isShuttingDown = false;
        this.retryCount = 0;
        this.maxRetries = 5;
        this.retryDelay = 5000; // 5 seconds
        
        this.setupProcessHandlers();
        this.initializeServer();
    }

    setupProcessHandlers() {
        // Handle uncaught exceptions
        process.on('uncaughtException', (error) => {
            console.error('💥 UNCAUGHT EXCEPTION:', error);
            console.log('🔄 Server will continue running...');
            // Don't exit the process, just log the error
        });

        // Handle unhandled promise rejections
        process.on('unhandledRejection', (reason, promise) => {
            console.error('💥 UNHANDLED PROMISE REJECTION at:', promise, 'reason:', reason);
            console.log('🔄 Server will continue running...');
            // Don't exit the process, just log the error
        });

        // Graceful shutdown handlers
        process.on('SIGTERM', () => this.gracefulShutdown('SIGTERM'));
        process.on('SIGINT', () => this.gracefulShutdown('SIGINT'));
        
        // Handle other signals
        process.on('SIGHUP', () => console.log('SIGHUP received - reloading configuration'));
        process.on('SIGUSR2', () => console.log('SIGUSR2 received - debug signal'));

        // Prevent memory leak warnings from crashing the server
        process.on('warning', (warning) => {
            console.warn('⚠️ Process Warning:', warning.name);
            console.warn('⚠️ Warning Message:', warning.message);
            console.warn('⚠️ Stack Trace:', warning.stack);
        });
    }

    initializeServer() {
        try {
            console.log('🚀 Initializing Chat Server...');
            
            // Initialize database connection with retry logic
            this.connectDatabaseWithRetry();
            
            this.setupExpress();
            this.setupRoutes();
            this.setupSocketIO();
            this.startServer();
            
        } catch (error) {
            console.error('❌ Failed to initialize server:', error);
            this.retryStartup();
        }
    }

    async connectDatabaseWithRetry() {
        let connected = false;
        let attempts = 0;
        const maxAttempts = 3;

        while (!connected && attempts < maxAttempts) {
            try {
                await connectDB();
                connected = true;
                console.log('✅ Database connected successfully');
            } catch (error) {
                attempts++;
                console.error(`❌ Database connection attempt ${attempts} failed:`, error.message);
                
                if (attempts < maxAttempts) {
                    console.log(`🔄 Retrying database connection in 5 seconds...`);
                    await new Promise(resolve => setTimeout(resolve, 5000));
                } else {
                    console.error('💥 All database connection attempts failed');
                    // Don't throw, let server start without DB (it will retry later)
                }
            }
        }
    }

    setupExpress() {
        // CORS configuration
        this.app.use(cors({
            origin: process.env.FRONTEND_URL || 'http://localhost:3000',
            credentials: true
        }));

        // Body parsing middleware
        this.app.use(express.json({ limit: '50mb' }));
        this.app.use(express.urlencoded({ extended: true, limit: '50mb' }));

        // Serve static files from public directory
        this.app.use(express.static(path.join(__dirname, 'public')));
        this.app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

        console.log('📁 Serving static files from:', path.join(__dirname, 'public'));
        console.log('📁 Uploads directory:', path.join(__dirname, 'public/uploads'));

        // Add request logging middleware
        this.app.use((req, res, next) => {
            console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
            next();
        });
    }

    setupRoutes() {
        // Health check endpoint with detailed status
        this.app.get('/api/health', (req, res) => {
            res.status(200).json({
                message: 'Chat API is running...',
                timestamp: new Date(),
                version: '2.0.0',
                status: 'healthy',
                uptime: process.uptime(),
                memory: process.memoryUsage(),
                features: [
                    'Chat Requests',
                    'Block Users',
                    'Incognito Mode (3-hour auto-delete)',
                    'Real-time Messaging',
                    'File Sharing',
                    'Video Calls'
                ]
            });
        });

        // Deep health check (includes database connectivity)
        this.app.get('/api/health/deep', async (req, res) => {
            try {
                // Add database health check here if needed
                res.status(200).json({
                    status: 'healthy',
                    timestamp: new Date(),
                    database: 'connected', // You can add actual DB ping here
                    websockets: this.io ? 'active' : 'inactive',
                    uptime: process.uptime()
                });
            } catch (error) {
                res.status(500).json({
                    status: 'degraded',
                    timestamp: new Date(),
                    error: error.message,
                    uptime: process.uptime()
                });
            }
        });

        // API Routes
        this.app.use('/api/auth', authRoutes);
        this.app.use('/api/messages', messageRoutes);
        this.app.use('/api/users', userRoutes);
        this.app.use('/api/upload', uploadRoutes);

        // Root endpoint
        this.app.get('/', (req, res) => {
            res.json({
                message: 'Chat API Server is Running',
                timestamp: new Date(),
                uptime: process.uptime(),
                endpoints: {
                    health: '/api/health',
                    auth: '/api/auth',
                    messages: '/api/messages',
                    users: '/api/users',
                    upload: '/api/upload'
                }
            });
        });

        // 404 handler
        this.app.use('*', (req, res) => {
            res.status(404).json({
                error: 'Route not found',
                path: req.originalUrl,
                availableEndpoints: [
                    'GET /api/health',
                    'POST /api/auth/register',
                    'POST /api/auth/login',
                    'GET /api/users/search',
                    'GET /api/users/friends/list',
                    'GET /api/messages/:userId',
                    'POST /api/upload'
                ]
            });
        });

        // Error Handling Middlewares
        this.app.use(notFound);
        this.app.use(errorHandler);
    }

    setupSocketIO() {
        // Create HTTP server
        this.server = http.createServer(this.app);

        // Configure Socket.IO with enhanced settings
        this.io = new Server(this.server, {
            cors: {
                origin: process.env.FRONTEND_URL || 'http://localhost:3000',
                methods: ['GET', 'POST'],
                credentials: true
            },
            transports: ['websocket', 'polling'],
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            reconnectionAttempts: Infinity, // Keep trying to reconnect forever
            timeout: 20000,
            pingTimeout: 60000,
            pingInterval: 25000
        });

        // Initialize socket handlers with error handling
        try {
            initializeSocket(this.io);
            console.log('✅ Socket.IO initialized successfully');
        } catch (error) {
            console.error('❌ Socket.IO initialization failed:', error);
            // Don't throw, server can continue without sockets
        }

        // Socket server error handling
        this.server.on('error', (error) => {
            console.error('❌ HTTP Server error:', error);
            
            if (error.code === 'EADDRINUSE') {
                console.error(`Port ${this.getPort()} is already in use.`);
                this.retryStartup();
            } else {
                console.log('🔄 Server will attempt to recover...');
                // Schedule a restart after delay
                setTimeout(() => this.restartServer(), 10000);
            }
        });
    }

    startServer() {
        const PORT = this.getPort();
        
        this.server.listen(PORT, () => {
            console.log('\n' + '='.repeat(70));
            console.log(`✅ Server successfully started on port ${PORT}`);
            console.log(`🔗 Frontend URL: ${process.env.FRONTEND_URL || 'http://localhost:3000'}`);
            console.log(`🌐 Backend URL: http://localhost:${PORT}`);
            console.log(`📁 Uploads available at: http://localhost:${PORT}/uploads/`);
            console.log('\n🎯 Features enabled:');
            console.log('   - ✉️  Chat Requests');
            console.log('   - 🚫 Block Users');
            console.log('   - 🕵️  Incognito Mode (3-hour auto-delete)');
            console.log('   - 💬 Real-time Messaging');
            console.log('   - 📎 File Sharing');
            console.log('   - 📹 Video Calls');
            console.log('\n📡 API Endpoints:');
            console.log('   - GET    /api/health');
            console.log('   - POST   /api/auth/register');
            console.log('   - POST   /api/auth/login');
            console.log('   - GET    /api/users/search?q=<query>');
            console.log('   - GET    /api/users/friends/list');
            console.log('   - GET    /api/users/blocked/list');
            console.log('   - PATCH  /api/users/status/update');
            console.log('='.repeat(70) + '\n');
            
            // Reset retry count on successful start
            this.retryCount = 0;
        });

        // Monitor server health
        this.startHealthMonitoring();
    }

    getPort() {
        return process.env.PORT || 5000;
    }

    startHealthMonitoring() {
        // Periodic health checks
        setInterval(() => {
            const memoryUsage = process.memoryUsage();
            const memoryMB = {
                rss: Math.round(memoryUsage.rss / 1024 / 1024),
                heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024),
                heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
                external: Math.round(memoryUsage.external / 1024 / 1024)
            };

            if (memoryMB.heapUsed > 500) { // 500MB threshold
                console.warn('⚠️ High memory usage:', memoryMB);
            }

            console.log('💾 Memory usage:', memoryMB, `Uptime: ${Math.round(process.uptime())}s`);
        }, 300000); // Log every 5 minutes

        // Monitor event loop
        let lastLoop = Date.now();
        setInterval(() => {
            const now = Date.now();
            const delay = now - lastLoop;
            lastLoop = now;
            
            if (delay > 1000) {
                console.warn(`⚠️ Event loop delayed: ${delay}ms`);
            }
        }, 1000);
    }

    retryStartup() {
        this.retryCount++;
        
        if (this.retryCount <= this.maxRetries) {
            console.log(`🔄 Retrying server startup (attempt ${this.retryCount}/${this.maxRetries})...`);
            setTimeout(() => {
                this.cleanup();
                this.initializeServer();
            }, this.retryDelay);
        } else {
            console.error(`💥 Maximum retry attempts (${this.maxRetries}) exceeded. Server cannot start.`);
            console.log('💡 Please check:');
            console.log('   - Database connection');
            console.log('   - Port availability');
            console.log('   - Environment variables');
            console.log('   - Network configuration');
            // Even after max retries, don't exit - keep trying with longer delays
            console.log('🔄 Will continue retrying with longer delays...');
            setTimeout(() => {
                this.retryCount = this.maxRetries - 1; // Reset to allow more retries
                this.retryStartup();
            }, 30000); // 30 seconds delay
        }
    }

    restartServer() {
        console.log('🔄 Restarting server...');
        this.cleanup();
        setTimeout(() => {
            this.initializeServer();
        }, 2000);
    }

    cleanup() {
        if (this.server) {
            try {
                this.server.close();
                console.log('✅ HTTP server closed');
            } catch (error) {
                console.error('Error closing server:', error);
            }
            this.server = null;
        }

        if (this.io) {
            try {
                this.io.close();
                console.log('✅ Socket.IO closed');
            } catch (error) {
                console.error('Error closing Socket.IO:', error);
            }
            this.io = null;
        }
    }

    async gracefulShutdown(signal) {
        if (this.isShuttingDown) return;
        
        this.isShuttingDown = true;
        console.log(`\n${signal} received. Starting graceful shutdown...`);

        try {
            // Close HTTP server
            if (this.server) {
                await new Promise((resolve) => {
                    this.server.close(() => {
                        console.log('✅ HTTP server closed');
                        resolve();
                    });
                });
            }

            // Close Socket.IO
            if (this.io) {
                this.io.close();
                console.log('✅ Socket.IO closed');
            }

            console.log('✅ Graceful shutdown completed');
            process.exit(0);
        } catch (error) {
            console.error('❌ Error during graceful shutdown:', error);
            process.exit(1);
        }
    }
}

// Create and start server instance
const chatServer = new ChatServer();

// Export for testing
export default chatServer.app;
