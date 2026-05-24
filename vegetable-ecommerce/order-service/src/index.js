const express = require('express');
const mongoose = require('mongoose');
const Redis = require('ioredis');
const Bull = require('bull');
const axios = require('axios');
const winston = require('winston');

const app = express();
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

// Logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: 'order-service' },
  transports: [new winston.transports.Console()]
});

app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/vegetable_orders', {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

// Order Schema with DENORMALIZED price snapshot
const orderSchema = new mongoose.Schema({
  orderNumber: { type: String, unique: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  userEmail: String,

  // Order Status Machine
  status: {
    type: String,
    enum: ['pending', 'reserved', 'payment_processing', 'paid', 'packed', 'shipped', 'delivered', 'cancelled', 'refunded'],
    default: 'pending',
    index: true
  },

  // Payment info
  payment: {
    status: { type: String, enum: ['pending', 'processing', 'completed', 'failed', 'refunded'], default: 'pending' },
    method: { type: String, enum: ['card', 'upi', 'cod', 'wallet'] },
    transactionId: String,
    paidAt: Date,
    amount: Number
  },

  // Items with DENORMALIZED price snapshot (immutable record)
  items: [{
    productId: { type: mongoose.Schema.Types.ObjectId, required: true },
    sku: { type: String, required: true },
    name: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1 },

    // PRICE SNAPSHOT - locked at time of order
    unitPrice: { type: Number, required: true },
    originalPrice: Number, // Before discount
    discount: { type: Number, default: 0 },
    totalPrice: { type: Number, required: true }, // unitPrice * quantity - discount

    // Product snapshot (denormalized for historical record)
    image: String,
    category: String,
    attributes: mongoose.Schema.Types.Mixed,

    // Inventory tracking
    inventoryStatus: { 
      type: String, 
      enum: ['reserved', 'deducted', 'released', 'failed'],
      default: 'reserved'
    }
  }],

  // Pricing summary
  pricing: {
    subtotal: Number,
    tax: Number,
    deliveryFee: Number,
    discount: Number,
    total: Number,
    currency: { type: String, default: 'INR' }
  },

  // Delivery info
  delivery: {
    address: {
      street: String,
      city: String,
      state: String,
      zipCode: String,
      coordinates: { lat: Number, lng: Number }
    },
    scheduledDate: Date,
    timeSlot: String,
    instructions: String,
    status: { type: String, enum: ['pending', 'assigned', 'picked', 'in_transit', 'delivered'], default: 'pending' },
    partnerId: mongoose.Schema.Types.ObjectId,
    trackingUrl: String
  },

  // Saga pattern tracking
  saga: {
    currentStep: String,
    steps: [{
      step: String,
      status: { type: String, enum: ['pending', 'success', 'failed', 'compensating', 'compensated'] },
      service: String,
      timestamp: Date,
      error: String
    }]
  },

  // Metadata
  ipAddress: String,
  userAgent: String,
  notes: String,

  createdAt: { type: Date, default: Date.now, index: true },
  updatedAt: { type: Date, default: Date.now }
});

// Indexes for common queries
orderSchema.index({ userId: 1, createdAt: -1 }); // User order history
orderSchema.index({ status: 1, createdAt: -1 }); // Admin dashboard
orderSchema.index({ orderNumber: 'text' });

const Order = mongoose.model('Order', orderSchema);

// Message Queues
const orderQueue = new Bull('order-processing', {
  redis: process.env.REDIS_URL || 'redis://localhost:6379'
});

const notificationQueue = new Bull('notifications', {
  redis: process.env.REDIS_URL || 'redis://localhost:6379'
});

// Service URLs (from env or service discovery)
const SERVICES = {
  inventory: process.env.INVENTORY_SERVICE_URL || 'http://localhost:5004',
  payment: process.env.PAYMENT_SERVICE_URL || 'http://localhost:5005',
  product: process.env.PRODUCT_SERVICE_URL || 'http://localhost:5002'
};

// Generate order number
const generateOrderNumber = () => {
  const prefix = 'VEG';
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `${prefix}-${timestamp}-${random}`;
};

// Middleware
const traceMiddleware = (req, res, next) => {
  req.correlationId = req.headers['x-correlation-id'] || 'unknown';
  req.userId = req.headers['x-user-id'];
  req.userRole = req.headers['x-user-role'];
  next();
};

app.use(traceMiddleware);

// Create Order (with inventory reservation)
app.post('/', async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { items, deliveryAddress, paymentMethod, scheduledDate, timeSlot } = req.body;
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Step 1: Validate items and fetch current prices (from product service)
    const orderItems = [];
    let subtotal = 0;

    for (const item of items) {
      // Fetch product details with current price
      const productResponse = await axios.get(
        `${SERVICES.product}/${item.productId}`,
        { headers: { 'x-correlation-id': req.correlationId } }
      );

      const product = productResponse.data;

      // Check inventory availability
      const stockResponse = await axios.get(
        `${SERVICES.inventory}/check/${product.inventory.sku}?quantity=${item.quantity}`,
        { headers: { 'x-correlation-id': req.correlationId } }
      );

      if (!stockResponse.data.available) {
        throw new Error(`Insufficient stock for ${product.name}`);
      }

      // Create order item with PRICE SNAPSHOT
      const unitPrice = product.currentPrice.amount;
      const totalPrice = unitPrice * item.quantity;

      orderItems.push({
        productId: item.productId,
        sku: product.inventory.sku,
        name: product.name,
        quantity: item.quantity,
        unitPrice: unitPrice,
        originalPrice: unitPrice,
        discount: 0,
        totalPrice: totalPrice,
        image: product.images.find(img => img.isPrimary)?.url || product.images[0]?.url,
        category: product.category,
        attributes: product.attributes
      });

      subtotal += totalPrice;
    }

    // Step 2: Reserve inventory for all items
    for (const item of orderItems) {
      await axios.post(
        `${SERVICES.inventory}/reserve`,
        { sku: item.sku, quantity: item.quantity },
        { headers: { 'x-correlation-id': req.correlationId } }
      );
    }

    // Step 3: Calculate pricing
    const tax = subtotal * 0.05; // 5% tax
    const deliveryFee = subtotal > 500 ? 0 : 40; // Free delivery above 500
    const total = subtotal + tax + deliveryFee;

    // Step 4: Create order document
    const order = new Order({
      orderNumber: generateOrderNumber(),
      userId,
      status: 'reserved',
      payment: {
        status: 'pending',
        method: paymentMethod,
        amount: total
      },
      items: orderItems,
      pricing: {
        subtotal,
        tax,
        deliveryFee,
        discount: 0,
        total,
        currency: 'INR'
      },
      delivery: {
        address: deliveryAddress,
        scheduledDate: new Date(scheduledDate),
        timeSlot
      },
      saga: {
        currentStep: 'inventory_reserved',
        steps: [
          { step: 'validate_items', status: 'success', service: 'product-service', timestamp: new Date() },
          { step: 'reserve_inventory', status: 'success', service: 'inventory-service', timestamp: new Date() }
        ]
      }
    });

    await order.save({ session });
    await session.commitTransaction();

    // Queue background jobs
    await notificationQueue.add('order-created', {
      orderId: order._id,
      orderNumber: order.orderNumber,
      userEmail: req.body.userEmail,
      total: order.pricing.total
    });

    logger.info('Order created', { 
      orderId: order._id, 
      orderNumber: order.orderNumber,
      correlationId: req.correlationId 
    });

    res.status(201).json({
      message: 'Order created successfully',
      order: {
        id: order._id,
        orderNumber: order.orderNumber,
        status: order.status,
        items: order.items,
        pricing: order.pricing,
        createdAt: order.createdAt
      }
    });

  } catch (error) {
    await session.abortTransaction();

    // Compensating transaction: Release reserved inventory
    if (error.message.includes('Insufficient stock')) {
      logger.warn('Order failed - releasing inventory', { correlationId: req.correlationId });
      // Release logic would go here
    }

    logger.error('Order creation failed', { 
      error: error.message, 
      correlationId: req.correlationId 
    });

    res.status(500).json({ 
      error: 'Failed to create order',
      details: error.message 
    });
  } finally {
    session.endSession();
  }
});

// Process payment (triggered by payment service webhook or frontend)
app.post('/:orderId/pay', async (req, res) => {
  try {
    const { orderId } = req.params;
    const { paymentDetails } = req.body;

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.status !== 'reserved') {
      return res.status(400).json({ error: `Cannot pay for order in ${order.status} status` });
    }

    // Update status
    order.status = 'payment_processing';
    order.saga.steps.push({
      step: 'process_payment',
      status: 'pending',
      service: 'payment-service',
      timestamp: new Date()
    });
    await order.save();

    // Call payment service
    const paymentResult = await axios.post(
      `${SERVICES.payment}/process`,
      {
        orderId: order._id,
        orderNumber: order.orderNumber,
        amount: order.pricing.total,
        currency: order.pricing.currency,
        method: order.payment.method,
        ...paymentDetails
      },
      { headers: { 'x-correlation-id': req.correlationId } }
    );

    if (paymentResult.data.success) {
      // Payment succeeded - deduct inventory
      order.status = 'paid';
      order.payment.status = 'completed';
      order.payment.transactionId = paymentResult.data.transactionId;
      order.payment.paidAt = new Date();

      // Deduct inventory for all items
      for (const item of order.items) {
        await axios.post(
          `${SERVICES.inventory}/deduct`,
          { sku: item.sku, quantity: item.quantity, orderId: order._id },
          { headers: { 'x-correlation-id': req.correlationId } }
        );
        item.inventoryStatus = 'deducted';
      }

      order.saga.steps.push(
        { step: 'process_payment', status: 'success', service: 'payment-service', timestamp: new Date() },
        { step: 'deduct_inventory', status: 'success', service: 'inventory-service', timestamp: new Date() }
      );

      await order.save();

      // Queue notifications
      await notificationQueue.add('payment-success', {
        orderId: order._id,
        orderNumber: order.orderNumber,
        amount: order.pricing.total
      });

      logger.info('Payment processed successfully', { 
        orderId, 
        transactionId: paymentResult.data.transactionId,
        correlationId: req.correlationId 
      });

      res.json({
        success: true,
        order: {
          id: order._id,
          orderNumber: order.orderNumber,
          status: order.status,
          payment: order.payment
        }
      });
    } else {
      // Payment failed - release inventory
      throw new Error('Payment failed');
    }

  } catch (error) {
    // Compensating transaction: Release inventory
    const order = await Order.findById(orderId);
    if (order) {
      order.status = 'cancelled';
      order.payment.status = 'failed';

      for (const item of order.items) {
        if (item.inventoryStatus === 'reserved') {
          await axios.post(
            `${SERVICES.inventory}/release`,
            { sku: item.sku, quantity: item.quantity, orderId: order._id },
            { headers: { 'x-correlation-id': req.correlationId } }
          );
          item.inventoryStatus = 'released';
        }
      }

      order.saga.steps.push({
        step: 'process_payment',
        status: 'failed',
        service: 'payment-service',
        timestamp: new Date(),
        error: error.message
      });

      await order.save();

      await notificationQueue.add('payment-failed', {
        orderId: order._id,
        reason: error.message
      });
    }

    logger.error('Payment processing failed', { 
      orderId, 
      error: error.message,
      correlationId: req.correlationId 
    });

    res.status(500).json({ 
      error: 'Payment failed',
      details: error.message 
    });
  }
});

// Get order by ID (with price snapshot - immutable!)
app.get('/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const userId = req.userId;

    const order = await Order.findById(orderId).lean();
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Users can only see their own orders (unless admin)
    if (order.userId.toString() !== userId && req.userRole !== 'admin') {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    res.json(order);
  } catch (error) {
    logger.error('Failed to fetch order', { error: error.message, correlationId: req.correlationId });
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

// Get user orders
app.get('/user/list', async (req, res) => {
  try {
    const userId = req.userId;
    const { page = 1, limit = 10, status } = req.query;

    const query = { userId };
    if (status) query.status = status;

    const orders = await Order.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .select('orderNumber status pricing.total items.name items.quantity items.totalPrice createdAt')
      .lean();

    const total = await Order.countDocuments(query);

    res.json({
      orders,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    logger.error('Failed to fetch user orders', { error: error.message, correlationId: req.correlationId });
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// Cancel order (with compensating transactions)
app.post('/:orderId/cancel', async (req, res) => {
  try {
    const { orderId } = req.params;
    const { reason } = req.body;

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Can only cancel if not shipped
    if (['shipped', 'delivered', 'cancelled', 'refunded'].includes(order.status)) {
      return res.status(400).json({ error: `Cannot cancel order in ${order.status} status` });
    }

    // Release inventory
    for (const item of order.items) {
      if (item.inventoryStatus === 'reserved' || item.inventoryStatus === 'deducted') {
        await axios.post(
          `${SERVICES.inventory}/release`,
          { sku: item.sku, quantity: item.quantity, orderId: order._id },
          { headers: { 'x-correlation-id': req.correlationId } }
        );
        item.inventoryStatus = 'released';
      }
    }

    // If paid, trigger refund
    if (order.payment.status === 'completed') {
      await axios.post(
        `${SERVICES.payment}/refund`,
        {
          transactionId: order.payment.transactionId,
          amount: order.pricing.total,
          reason
        },
        { headers: { 'x-correlation-id': req.correlationId } }
      );
      order.payment.status = 'refunded';
    }

    order.status = 'cancelled';
    order.notes = reason;
    order.saga.steps.push({
      step: 'cancel_order',
      status: 'success',
      service: 'order-service',
      timestamp: new Date()
    });

    await order.save();

    await notificationQueue.add('order-cancelled', {
      orderId: order._id,
      orderNumber: order.orderNumber,
      reason
    });

    logger.info('Order cancelled', { orderId, reason, correlationId: req.correlationId });
    res.json({ success: true, message: 'Order cancelled successfully' });

  } catch (error) {
    logger.error('Order cancellation failed', { 
      orderId, 
      error: error.message,
      correlationId: req.correlationId 
    });
    res.status(500).json({ error: 'Cancellation failed' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'order-service', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 5003;
app.listen(PORT, () => {
  logger.info(`Order Service running on port ${PORT}`);
});

module.exports = app;
