const express = require('express');
const mongoose = require('mongoose');
const Redis = require('ioredis');
const Bull = require('bull');
const winston = require('winston');
const crypto = require('crypto');

const app = express();
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

// Logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: 'payment-service' },
  transports: [new winston.transports.Console()]
});

app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/vegetable_payments', {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

// Payment Transaction Schema
const paymentSchema = new mongoose.Schema({
  transactionId: { type: String, unique: true, index: true },
  orderId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  orderNumber: String,

  amount: { type: Number, required: true },
  currency: { type: String, default: 'INR' },

  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed', 'refunded', 'partially_refunded'],
    default: 'pending',
    index: true
  },

  method: {
    type: String,
    enum: ['card', 'upi', 'cod', 'wallet'],
    required: true
  },

  // Payment details (encrypted in production)
  details: {
    cardLast4: String,
    cardBrand: String,
    upiId: String,
    walletType: String
  },

  // Idempotency key (prevents double charges)
  idempotencyKey: { type: String, unique: true, index: true },

  // Gateway response
  gatewayResponse: mongoose.Schema.Types.Mixed,

  // Refund info
  refund: {
    amount: Number,
    reason: String,
    status: { type: String, enum: ['pending', 'completed', 'failed'] },
    transactionId: String,
    processedAt: Date
  },

  // Retry logic
  retryCount: { type: Number, default: 0 },
  maxRetries: { type: Number, default: 3 },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

paymentSchema.index({ orderId: 1, status: 1 });
paymentSchema.index({ createdAt: -1 });

const Payment = mongoose.model('Payment', paymentSchema);

// Idempotency key generation
const generateIdempotencyKey = (orderId, amount, timestamp) => {
  return crypto
    .createHash('sha256')
    .update(`${orderId}:${amount}:${timestamp}`)
    .digest('hex');
};

// Mock payment gateway (replace with Stripe/Razorpay in production)
const mockPaymentGateway = async (paymentData) => {
  // Simulate network delay
  await new Promise(resolve => setTimeout(resolve, 500));

  // Simulate 95% success rate
  const isSuccess = Math.random() > 0.05;

  if (isSuccess) {
    return {
      success: true,
      gatewayTransactionId: `TXN${Date.now()}${Math.random().toString(36).substr(2, 9).toUpperCase()}`,
      status: 'captured',
      timestamp: new Date().toISOString()
    };
  } else {
    throw new Error('Payment gateway error: Transaction declined');
  }
};

// Retry queue with exponential backoff
const paymentRetryQueue = new Bull('payment-retries', {
  redis: process.env.REDIS_URL || 'redis://localhost:6379'
});

paymentRetryQueue.process(async (job) => {
  const { paymentId } = job.data;
  const payment = await Payment.findById(paymentId);

  if (!payment || payment.retryCount >= payment.maxRetries) {
    logger.error('Max retries exceeded', { paymentId });
    return;
  }

  try {
    const result = await mockPaymentGateway({
      amount: payment.amount,
      currency: payment.currency,
      method: payment.method
    });

    payment.status = 'completed';
    payment.gatewayResponse = result;
    await payment.save();

    logger.info('Payment retry succeeded', { paymentId, attempt: payment.retryCount + 1 });
  } catch (error) {
    payment.retryCount += 1;
    await payment.save();

    if (payment.retryCount < payment.maxRetries) {
      // Exponential backoff: 2^attempt * 1000ms + jitter
      const delay = Math.pow(2, payment.retryCount) * 1000 + Math.random() * 1000;
      await paymentRetryQueue.add({ paymentId }, { delay });
    }
  }
});

// Middleware
const traceMiddleware = (req, res, next) => {
  req.correlationId = req.headers['x-correlation-id'] || 'unknown';
  next();
};

app.use(traceMiddleware);

// Process payment
app.post('/process', async (req, res) => {
  try {
    const { orderId, orderNumber, amount, currency, method, cardToken, upiId } = req.body;

    // Check idempotency (prevent double charges)
    const idempotencyKey = generateIdempotencyKey(orderId, amount, Date.now());
    const existingPayment = await Payment.findOne({ idempotencyKey });

    if (existingPayment) {
      logger.info('Idempotency hit - returning existing payment', { 
        paymentId: existingPayment._id,
        correlationId: req.correlationId 
      });
      return res.json({
        success: existingPayment.status === 'completed',
        transactionId: existingPayment.transactionId,
        status: existingPayment.status
      });
    }

    // Create payment record
    const payment = new Payment({
      transactionId: `PAY${Date.now()}${Math.random().toString(36).substr(2, 6).toUpperCase()}`,
      orderId,
      orderNumber,
      amount,
      currency,
      method,
      idempotencyKey,
      status: 'processing'
    });

    await payment.save();

    // For COD, mark as completed immediately
    if (method === 'cod') {
      payment.status = 'completed';
      payment.gatewayResponse = { method: 'cod', status: 'pending_delivery' };
      await payment.save();

      logger.info('COD payment recorded', { 
        paymentId: payment._id,
        correlationId: req.correlationId 
      });

      return res.json({
        success: true,
        transactionId: payment.transactionId,
        status: 'completed',
        method: 'cod'
      });
    }

    // Process through gateway
    try {
      const gatewayResult = await mockPaymentGateway({
        amount,
        currency,
        method,
        cardToken,
        upiId
      });

      payment.status = 'completed';
      payment.gatewayResponse = gatewayResult;
      payment.details = {
        cardLast4: '4242', // Mock
        cardBrand: 'visa',
        upiId: upiId ? upiId.replace(/.(?=.{4})/g, '*') : undefined
      };
      await payment.save();

      logger.info('Payment processed', { 
        paymentId: payment._id,
        transactionId: payment.transactionId,
        correlationId: req.correlationId 
      });

      res.json({
        success: true,
        transactionId: payment.transactionId,
        status: 'completed',
        gatewayTransactionId: gatewayResult.gatewayTransactionId
      });

    } catch (gatewayError) {
      payment.status = 'failed';
      payment.gatewayResponse = { error: gatewayError.message };
      await payment.save();

      // Queue for retry
      await paymentRetryQueue.add({ paymentId: payment._id }, { delay: 2000 });

      logger.error('Payment gateway error', { 
        paymentId: payment._id,
        error: gatewayError.message,
        correlationId: req.correlationId 
      });

      throw gatewayError;
    }

  } catch (error) {
    logger.error('Payment processing failed', { 
      error: error.message,
      correlationId: req.correlationId 
    });
    res.status(500).json({ 
      success: false,
      error: 'Payment processing failed',
      details: error.message 
    });
  }
});

// Refund endpoint
app.post('/refund', async (req, res) => {
  try {
    const { transactionId, amount, reason } = req.body;

    const payment = await Payment.findOne({ transactionId });
    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    if (payment.status !== 'completed') {
      return res.status(400).json({ error: 'Can only refund completed payments' });
    }

    // Process refund through gateway
    const refundResult = await mockPaymentGateway({
      amount: -amount, // Negative for refund
      currency: payment.currency,
      method: payment.method
    });

    payment.status = 'refunded';
    payment.refund = {
      amount,
      reason,
      status: 'completed',
      transactionId: refundResult.gatewayTransactionId,
      processedAt: new Date()
    };
    await payment.save();

    logger.info('Refund processed', { 
      paymentId: payment._id,
      refundAmount: amount,
      correlationId: req.correlationId 
    });

    res.json({
      success: true,
      refundId: payment.refund.transactionId,
      amount,
      status: 'refunded'
    });

  } catch (error) {
    logger.error('Refund failed', { 
      transactionId, 
      error: error.message,
      correlationId: req.correlationId 
    });
    res.status(500).json({ error: 'Refund failed' });
  }
});

// Get payment status
app.get('/:transactionId', async (req, res) => {
  try {
    const { transactionId } = req.params;
    const payment = await Payment.findOne({ transactionId }).lean();

    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    res.json({
      transactionId: payment.transactionId,
      status: payment.status,
      amount: payment.amount,
      currency: payment.currency,
      method: payment.method,
      createdAt: payment.createdAt,
      refund: payment.refund
    });
  } catch (error) {
    logger.error('Failed to fetch payment', { error: error.message, correlationId: req.correlationId });
    res.status(500).json({ error: 'Failed to fetch payment' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'payment-service', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 5005;
app.listen(PORT, () => {
  logger.info(`Payment Service running on port ${PORT}`);
});

module.exports = app;
