const express = require('express');
const mongoose = require('mongoose');
const Redis = require('ioredis');
const Bull = require('bull');
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
  defaultMeta: { service: 'inventory-service' },
  transports: [new winston.transports.Console()]
});

app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/vegetable_inventory', {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

// Inventory Schema
const inventorySchema = new mongoose.Schema({
  sku: { type: String, required: true, unique: true, index: true },
  productId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  productName: String,

  // Stock levels
  quantity: { 
    type: Number, 
    required: true, 
    min: 0,
    default: 0 
  },
  reservedQuantity: { type: Number, default: 0 }, // For pending orders
  availableQuantity: { type: Number, default: 0 }, // quantity - reserved

  // Thresholds
  lowStockThreshold: { type: Number, default: 10 },
  reorderPoint: { type: Number, default: 20 },
  maxStock: { type: Number, default: 1000 },

  // Tracking
  warehouse: {
    id: String,
    location: String,
    zone: String
  },

  // Batch tracking (for vegetables with expiry)
  batches: [{
    batchId: String,
    quantity: Number,
    expiryDate: Date,
    receivedDate: { type: Date, default: Date.now },
    supplier: String
  }],

  // Analytics
  totalSold: { type: Number, default: 0 },
  totalReserved: { type: Number, default: 0 },
  lastRestocked: Date,

  // Status
  status: {
    type: String,
    enum: ['in_stock', 'low_stock', 'out_of_stock', 'discontinued'],
    default: 'out_of_stock'
  },

  isActive: { type: Boolean, default: true },
  version: { type: Number, default: 0 }, // For optimistic locking
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

inventorySchema.index({ status: 1 });
inventorySchema.index({ productId: 1, sku: 1 });

// Update status based on quantities before saving
inventorySchema.pre('save', function(next) {
  this.availableQuantity = this.quantity - this.reservedQuantity;

  if (this.quantity <= 0) {
    this.status = 'out_of_stock';
  } else if (this.quantity <= this.lowStockThreshold) {
    this.status = 'low_stock';
  } else {
    this.status = 'in_stock';
  }

  this.updatedAt = Date.now();
  next();
});

const Inventory = mongoose.model('Inventory', inventorySchema);

// Stock Movement Log (for audit trail)
const stockMovementSchema = new mongoose.Schema({
  sku: String,
  productId: mongoose.Schema.Types.ObjectId,
  type: { type: String, enum: ['in', 'out', 'reserve', 'release', 'adjustment'] },
  quantity: Number,
  previousQuantity: Number,
  newQuantity: Number,
  orderId: mongoose.Schema.Types.ObjectId,
  reason: String,
  performedBy: mongoose.Schema.Types.ObjectId,
  timestamp: { type: Date, default: Date.now }
});

const StockMovement = mongoose.model('StockMovement', stockMovementSchema);

// Message Queue for low stock alerts
const lowStockQueue = new Bull('low-stock-alerts', {
  redis: process.env.REDIS_URL || 'redis://localhost:6379'
});

// Process low stock alerts
lowStockQueue.process(async (job) => {
  const { sku, productName, currentStock } = job.data;
  logger.warn('Low stock alert', { sku, productName, currentStock });
  // In production: Send email, Slack notification, trigger reorder
});

// Middleware
const traceMiddleware = (req, res, next) => {
  req.correlationId = req.headers['x-correlation-id'] || 'unknown';
  req.userId = req.headers['x-user-id'];
  next();
};

app.use(traceMiddleware);

// Check stock availability
app.get('/check/:sku', async (req, res) => {
  try {
    const { sku } = req.params;
    const { quantity = 1 } = req.query;

    const inventory = await Inventory.findOne({ sku, isActive: true }).lean();

    if (!inventory) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const available = inventory.availableQuantity >= Number(quantity);

    res.json({
      sku,
      available,
      requestedQuantity: Number(quantity),
      availableQuantity: inventory.availableQuantity,
      status: inventory.status,
      lowStock: inventory.status === 'low_stock'
    });
  } catch (error) {
    logger.error('Stock check failed', { error: error.message, correlationId: req.correlationId });
    res.status(500).json({ error: 'Stock check failed' });
  }
});

// Reserve stock (for checkout process)
app.post('/reserve', async (req, res) => {
  try {
    const { sku, quantity, orderId } = req.body;

    // ATOMIC UPDATE - Race condition prevention
    // This is the key pattern: Update with condition, don't read then write
    const result = await Inventory.updateOne(
      { 
        sku, 
        isActive: true,
        $expr: { $gte: [{ $subtract: ['$quantity', '$reservedQuantity'] }, quantity] }
      },
      {
        $inc: { reservedQuantity: quantity },
        $set: { updatedAt: new Date() }
      }
    );

    if (result.modifiedCount === 0) {
      logger.warn('Stock reservation failed - insufficient stock', { 
        sku, 
        requested: quantity,
        correlationId: req.correlationId 
      });
      return res.status(409).json({ 
        error: 'Insufficient stock',
        sku,
        requested: quantity
      });
    }

    // Log the movement
    const inventory = await Inventory.findOne({ sku });
    await StockMovement.create({
      sku,
      productId: inventory.productId,
      type: 'reserve',
      quantity,
      previousQuantity: inventory.availableQuantity + quantity,
      newQuantity: inventory.availableQuantity,
      orderId,
      reason: 'Order reservation'
    });

    // Check if low stock after reservation
    if (inventory.availableQuantity <= inventory.lowStockThreshold) {
      await lowStockQueue.add({
        sku,
        productName: inventory.productName,
        currentStock: inventory.availableQuantity
      });
    }

    logger.info('Stock reserved', { 
      sku, 
      quantity, 
      orderId,
      correlationId: req.correlationId 
    });

    res.json({
      success: true,
      sku,
      reserved: quantity,
      availableNow: inventory.availableQuantity
    });
  } catch (error) {
    logger.error('Reservation failed', { error: error.message, correlationId: req.correlationId });
    res.status(500).json({ error: 'Reservation failed' });
  }
});

// Confirm stock deduction (when payment succeeds)
app.post('/deduct', async (req, res) => {
  try {
    const { sku, quantity, orderId } = req.body;

    // Atomic: Decrease both quantity and reservedQuantity
    const result = await Inventory.updateOne(
      { sku, isActive: true, reservedQuantity: { $gte: quantity } },
      {
        $inc: { 
          quantity: -quantity,
          reservedQuantity: -quantity,
          totalSold: quantity
        },
        $set: { updatedAt: new Date() }
      }
    );

    if (result.modifiedCount === 0) {
      return res.status(409).json({ error: 'Cannot deduct stock' });
    }

    const inventory = await Inventory.findOne({ sku });

    await StockMovement.create({
      sku,
      productId: inventory.productId,
      type: 'out',
      quantity: -quantity,
      previousQuantity: inventory.quantity + quantity,
      newQuantity: inventory.quantity,
      orderId,
      reason: 'Order confirmed'
    });

    logger.info('Stock deducted', { sku, quantity, orderId, correlationId: req.correlationId });
    res.json({ success: true, sku, deducted: quantity });
  } catch (error) {
    logger.error('Deduction failed', { error: error.message, correlationId: req.correlationId });
    res.status(500).json({ error: 'Deduction failed' });
  }
});

// Release reservation (when payment fails or order cancelled)
app.post('/release', async (req, res) => {
  try {
    const { sku, quantity, orderId } = req.body;

    const result = await Inventory.updateOne(
      { sku, isActive: true },
      {
        $inc: { reservedQuantity: -quantity },
        $set: { updatedAt: new Date() }
      }
    );

    if (result.modifiedCount === 0) {
      return res.status(404).json({ error: 'Inventory not found' });
    }

    const inventory = await Inventory.findOne({ sku });

    await StockMovement.create({
      sku,
      productId: inventory.productId,
      type: 'release',
      quantity,
      previousQuantity: inventory.availableQuantity - quantity,
      newQuantity: inventory.availableQuantity,
      orderId,
      reason: 'Order cancelled/payment failed'
    });

    logger.info('Stock released', { sku, quantity, orderId, correlationId: req.correlationId });
    res.json({ success: true, sku, released: quantity });
  } catch (error) {
    logger.error('Release failed', { error: error.message, correlationId: req.correlationId });
    res.status(500).json({ error: 'Release failed' });
  }
});

// Restock (admin/vendor)
app.post('/restock', async (req, res) => {
  try {
    const { sku, quantity, batchId, expiryDate, supplier, performedBy } = req.body;

    const inventory = await Inventory.findOneAndUpdate(
      { sku, isActive: true },
      {
        $inc: { quantity: quantity },
        $push: {
          batches: {
            batchId,
            quantity,
            expiryDate: new Date(expiryDate),
            supplier
          }
        },
        $set: { 
          lastRestocked: new Date(),
          updatedAt: new Date()
        }
      },
      { new: true }
    );

    if (!inventory) {
      return res.status(404).json({ error: 'Inventory not found' });
    }

    await StockMovement.create({
      sku,
      productId: inventory.productId,
      type: 'in',
      quantity,
      previousQuantity: inventory.quantity - quantity,
      newQuantity: inventory.quantity,
      reason: `Restock from ${supplier}`,
      performedBy
    });

    logger.info('Stock restocked', { sku, quantity, supplier, correlationId: req.correlationId });
    res.json({ success: true, sku, restocked: quantity, newTotal: inventory.quantity });
  } catch (error) {
    logger.error('Restock failed', { error: error.message, correlationId: req.correlationId });
    res.status(500).json({ error: 'Restock failed' });
  }
});

// Get inventory levels (for admin dashboard)
app.get('/levels', async (req, res) => {
  try {
    const { status, page = 1, limit = 50 } = req.query;

    const query = { isActive: true };
    if (status) query.status = status;

    const inventories = await Inventory.find(query)
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .select('-batches') // Exclude batch details for performance
      .lean();

    const summary = await Inventory.aggregate([
      { $match: { isActive: true } },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          totalStock: { $sum: '$quantity' }
        }
      }
    ]);

    res.json({
      inventories,
      summary,
      pagination: { page: Number(page), limit: Number(limit) }
    });
  } catch (error) {
    logger.error('Failed to fetch inventory levels', { error: error.message, correlationId: req.correlationId });
    res.status(500).json({ error: 'Failed to fetch inventory levels' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'inventory-service', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 5004;
app.listen(PORT, () => {
  logger.info(`Inventory Service running on port ${PORT}`);
});

module.exports = app;
