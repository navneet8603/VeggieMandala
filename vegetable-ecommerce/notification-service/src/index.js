const express = require('express');
const mongoose = require('mongoose');
const Redis = require('ioredis');
const Bull = require('bull');
const nodemailer = require('nodemailer');
const winston = require('winston');
const { Server } = require('socket.io');
const http = require('http');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    methods: ['GET', 'POST']
  }
});

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

// Logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: 'notification-service' },
  transports: [new winston.transports.Console()]
});

app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/vegetable_notifications', {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

// Notification Log Schema
const notificationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  type: { type: String, enum: ['email', 'sms', 'push', 'in_app'], required: true },
  channel: String, // 'order_confirmation', 'low_stock', 'delivery_update'
  status: { type: String, enum: ['pending', 'sent', 'failed', 'delivered'], default: 'pending' },
  content: {
    subject: String,
    body: String,
    data: mongoose.Schema.Types.Mixed
  },
  recipient: String,
  sentAt: Date,
  deliveredAt: Date,
  error: String,
  createdAt: { type: Date, default: Date.now }
});

notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ status: 1, type: 1 });

const Notification = mongoose.model('Notification', notificationSchema);

// Email transporter (configure with your SMTP)
const emailTransporter = nodemailer.createTransporter({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: process.env.SMTP_PORT || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// Socket.io connection handling
const connectedUsers = new Map(); // userId -> socketId

io.on('connection', (socket) => {
  logger.info('Client connected', { socketId: socket.id });

  // Authenticate and register user
  socket.on('authenticate', (data) => {
    const { userId } = data;
    connectedUsers.set(userId.toString(), socket.id);
    socket.userId = userId;
    logger.info('User authenticated', { userId, socketId: socket.id });
  });

  // Join room for specific updates
  socket.on('subscribe_order', (orderId) => {
    socket.join(`order:${orderId}`);
    logger.info('User subscribed to order', { orderId, userId: socket.userId });
  });

  socket.on('disconnect', () => {
    if (socket.userId) {
      connectedUsers.delete(socket.userId.toString());
    }
    logger.info('Client disconnected', { socketId: socket.id });
  });
});

// Notification queues
const emailQueue = new Bull('email-notifications', {
  redis: process.env.REDIS_URL || 'redis://localhost:6379'
});

const smsQueue = new Bull('sms-notifications', {
  redis: process.env.REDIS_URL || 'redis://localhost:6379'
});

const pushQueue = new Bull('push-notifications', {
  redis: process.env.REDIS_URL || 'redis://localhost:6379'
});

// Email processor
emailQueue.process(async (job) => {
  const { userId, email, type, data } = job.data;

  try {
    let subject, html;

    switch (type) {
      case 'order_created':
        subject = `Order #${data.orderNumber} Confirmed`;
        html = `
          <h2>Thank you for your order!</h2>
          <p>Order Number: <strong>${data.orderNumber}</strong></p>
          <p>Total: ₹${data.total}</p>
          <p>We'll notify you when your vegetables are on the way!</p>
        `;
        break;

      case 'payment_success':
        subject = `Payment Received - Order #${data.orderNumber}`;
        html = `
          <h2>Payment Successful!</h2>
          <p>Your payment of ₹${data.amount} for order #${data.orderNumber} has been received.</p>
          <p>Your fresh vegetables are being prepared for delivery.</p>
        `;
        break;

      case 'order_shipped':
        subject = `Your Order #${data.orderNumber} is on the way!`;
        html = `
          <h2>Your vegetables are on the way!</h2>
          <p>Track your delivery: <a href="${data.trackingUrl}">Click here</a></p>
        `;
        break;

      case 'low_stock_alert':
        subject = `Low Stock Alert: ${data.productName}`;
        html = `
          <h2>Low Stock Warning</h2>
          <p>Product: ${data.productName}</p>
          <p>Current Stock: ${data.currentStock}</p>
          <p>Please restock soon!</p>
        `;
        break;

      default:
        subject = 'Notification from FreshVegetables';
        html = `<p>${JSON.stringify(data)}</p>`;
    }

    await emailTransporter.sendMail({
      from: '"Fresh Vegetables" <orders@freshvegetables.com>',
      to: email,
      subject,
      html
    });

    await Notification.create({
      userId,
      type: 'email',
      channel: type,
      status: 'sent',
      content: { subject, body: html },
      recipient: email,
      sentAt: new Date()
    });

    logger.info('Email sent', { userId, type, email });
  } catch (error) {
    logger.error('Email failed', { userId, type, error: error.message });
    await Notification.create({
      userId,
      type: 'email',
      channel: type,
      status: 'failed',
      recipient: email,
      error: error.message
    });
    throw error; // Bull will retry
  }
});

// Push notification processor (Socket.io)
pushQueue.process(async (job) => {
  const { userId, type, data } = job.data;

  try {
    const socketId = connectedUsers.get(userId.toString());

    if (socketId) {
      io.to(socketId).emit(type, data);

      // Also emit to order room if applicable
      if (data.orderId) {
        io.to(`order:${data.orderId}`).emit(type, data);
      }

      await Notification.create({
        userId,
        type: 'push',
        channel: type,
        status: 'delivered',
        content: { data },
        deliveredAt: new Date()
      });

      logger.info('Push notification delivered', { userId, type });
    } else {
      // User offline - store for later
      await Notification.create({
        userId,
        type: 'push',
        channel: type,
        status: 'pending',
        content: { data }
      });
      logger.info('Push notification queued (user offline)', { userId, type });
    }
  } catch (error) {
    logger.error('Push notification failed', { userId, type, error: error.message });
    throw error;
  }
});

// API endpoint to trigger notifications
app.post('/send', async (req, res) => {
  try {
    const { userId, type, channel, data, email } = req.body;

    switch (channel) {
      case 'email':
        await emailQueue.add({ userId, email, type, data }, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 }
        });
        break;

      case 'push':
        await pushQueue.add({ userId, type, data }, {
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 }
        });
        break;

      case 'all':
        await emailQueue.add({ userId, email, type, data });
        await pushQueue.add({ userId, type, data });
        break;
    }

    res.json({ success: true, message: 'Notification queued' });
  } catch (error) {
    logger.error('Notification queueing failed', { error: error.message });
    res.status(500).json({ error: 'Failed to queue notification' });
  }
});

// Get user notifications
app.get('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { page = 1, limit = 20 } = req.query;

    const notifications = await Notification.find({ userId })
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .lean();

    const unread = await Notification.countDocuments({ userId, status: 'pending' });

    res.json({ notifications, unread });
  } catch (error) {
    logger.error('Failed to fetch notifications', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

// Mark as read
app.patch('/:notificationId/read', async (req, res) => {
  try {
    await Notification.findByIdAndUpdate(req.params.notificationId, {
      status: 'delivered',
      deliveredAt: new Date()
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to mark as read' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    service: 'notification-service',
    connectedUsers: connectedUsers.size,
    timestamp: new Date().toISOString() 
  });
});

const PORT = process.env.PORT || 5006;
server.listen(PORT, () => {
  logger.info(`Notification Service running on port ${PORT}`);
});

module.exports = { app, server, io };
