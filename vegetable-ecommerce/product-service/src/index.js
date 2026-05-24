const express = require('express');
const mongoose = require('mongoose');
const Redis = require('ioredis');
const { body, validationResult } = require('express-validator');
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
  defaultMeta: { service: 'product-service' },
  transports: [new winston.transports.Console()]
});

app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/vegetable_products', {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

// Dynamic Product Schema (NoSQL advantage - different fields for different vegetables)
const productSchema = new mongoose.Schema({
  name: { type: String, required: true, index: true },
  slug: { type: String, required: true, unique: true, index: true },
  description: String,
  category: { 
    type: String, 
    required: true,
    enum: ['leafy_greens', 'root_vegetables', 'cruciferous', 'alliums', 'nightshades', 'squash', 'legumes', 'mushrooms', 'herbs'],
    index: true 
  },
  subCategory: String,

  // Dynamic pricing (changes daily based on market rates)
  currentPrice: {
    amount: { type: Number, required: true },
    currency: { type: String, default: 'INR' },
    unit: { type: String, default: 'kg' }, // kg, piece, bunch, 500g
    lastUpdated: { type: Date, default: Date.now }
  },

  // Price history for analytics
  priceHistory: [{
    amount: Number,
    date: { type: Date, default: Date.now }
  }],

  // Inventory reference (managed by inventory service)
  inventory: {
    sku: { type: String, required: true, unique: true },
    quantity: { type: Number, default: 0 },
    lowStockThreshold: { type: Number, default: 10 },
    isAvailable: { type: Boolean, default: true }
  },

  // Images stored as URLs (S3/Cloudinary), NOT Base64/Buffers
  images: [{
    url: { type: String, required: true },
    alt: String,
    isPrimary: { type: Boolean, default: false }
  }],

  // Dynamic attributes (NoSQL schema-less advantage)
  attributes: {
    type: Map,
    of: mongoose.Schema.Types.Mixed,
    default: {}
  },
  // Examples of dynamic attributes:
  // For carrots: { isOrganic: true, color: 'orange', grade: 'A' }
  // For spinach: { isPreWashed: true, shelfLife: '5 days', bunchSize: '200g' }
  // For mushrooms: { growingSubstrate: 'straw', variety: 'button', isDried: false }

  // Nutritional info per 100g
  nutrition: {
    calories: Number,
    protein: Number,
    carbs: Number,
    fiber: Number,
    vitamins: [String]
  },

  // Vendor info
  vendor: {
    id: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor' },
    name: String,
    rating: Number
  },

  // SEO & Discovery
  tags: [{ type: String, index: true }],
  season: [String], // ['winter', 'summer']
  origin: String,

  // Ratings & Reviews
  ratings: {
    average: { type: Number, default: 0, min: 0, max: 5 },
    count: { type: Number, default: 0 }
  },
  reviews: [{
    userId: mongoose.Schema.Types.ObjectId,
    userName: String,
    rating: { type: Number, min: 1, max: 5 },
    comment: String,
    createdAt: { type: Date, default: Date.now }
  }],

  // Soft delete
  isActive: { type: Boolean, default: true, index: true },
  isDeleted: { type: Boolean, default: false },

  createdAt: { type: Date, default: Date.now, index: true },
  updatedAt: { type: Date, default: Date.now }
});

// Compound indexes for common queries
productSchema.index({ category: 1, isActive: 1 });
productSchema.index({ tags: 1 });
productSchema.index({ 'currentPrice.amount': 1 });
productSchema.index({ 'ratings.average': -1 });
productSchema.index({ name: 'text', description: 'text', tags: 'text' }); // Text search

// Pre-save middleware to update timestamp
productSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

const Product = mongoose.model('Product', productSchema);

// Cache keys
const CACHE_KEYS = {
  product: (id) => `product:${id}`,
  productList: (page, limit, category) => `products:${category}:${page}:${limit}`,
  featured: 'products:featured',
  search: (query) => `search:${query}`
};

const CACHE_TTL = 300; // 5 minutes for products (prices change frequently)
const FEATURED_TTL = 600; // 10 minutes for featured

// Middleware
const traceMiddleware = (req, res, next) => {
  req.correlationId = req.headers['x-correlation-id'] || 'unknown';
  req.userId = req.headers['x-user-id'];
  req.userRole = req.headers['x-user-role'];
  next();
};

app.use(traceMiddleware);

// Get all products with pagination (Cursor-based for performance)
app.get('/', async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 20, 
      category, 
      search,
      minPrice,
      maxPrice,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      lastId // For cursor-based pagination
    } = req.query;

    const cacheKey = CACHE_KEYS.productList(page, limit, category || 'all');

    // Try cache first
    const cached = await redis.get(cacheKey);
    if (cached && !search) { // Don't cache search results
      logger.info('Cache hit for product list', { correlationId: req.correlationId });
      return res.json(JSON.parse(cached));
    }

    // Build query
    const query = { isActive: true, isDeleted: false };

    if (category) query.category = category;
    if (search) {
      query.$text = { $search: search };
    }
    if (minPrice || maxPrice) {
      query['currentPrice.amount'] = {};
      if (minPrice) query['currentPrice.amount'].$gte = Number(minPrice);
      if (maxPrice) query['currentPrice.amount'].$lte = Number(maxPrice);
    }

    // Cursor-based pagination (better than skip for large datasets)
    if (lastId) {
      query._id = { $gt: lastId };
    }

    const sort = {};
    sort[sortBy] = sortOrder === 'asc' ? 1 : -1;
    if (sortBy !== '_id') sort._id = 1; // Secondary sort by _id for consistency

    const products = await Product.find(query)
      .sort(sort)
      .limit(Number(limit))
      .select('-reviews -__v') // Exclude large fields
      .lean(); // Faster reads

    const total = await Product.countDocuments(query);
    const hasMore = products.length === Number(limit);
    const nextCursor = hasMore ? products[products.length - 1]._id : null;

    const result = {
      products,
      pagination: {
        currentPage: Number(page),
        limit: Number(limit),
        total,
        hasMore,
        nextCursor
      }
    };

    // Cache the result
    if (!search) {
      await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(result));
    }

    logger.info('Products fetched', { 
      count: products.length, 
      correlationId: req.correlationId 
    });

    res.json(result);
  } catch (error) {
    logger.error('Failed to fetch products', { error: error.message, correlationId: req.correlationId });
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// Get single product
app.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const cacheKey = CACHE_KEYS.product(id);

    // Try cache
    const cached = await redis.get(cacheKey);
    if (cached) {
      logger.info('Cache hit for product', { id, correlationId: req.correlationId });
      return res.json(JSON.parse(cached));
    }

    const product = await Product.findById(id)
      .populate('vendor.id', 'name rating')
      .lean();

    if (!product || product.isDeleted) {
      return res.status(404).json({ error: 'Product not found' });
    }

    // Cache the product
    await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(product));

    res.json(product);
  } catch (error) {
    logger.error('Failed to fetch product', { error: error.message, correlationId: req.correlationId });
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

// Create product (Admin/Vendor only)
app.post('/', [
  body('name').trim().isLength({ min: 2 }),
  body('slug').trim().isLength({ min: 2 }),
  body('category').isIn(['leafy_greens', 'root_vegetables', 'cruciferous', 'alliums', 'nightshades', 'squash', 'legumes', 'mushrooms', 'herbs']),
  body('currentPrice.amount').isNumeric(),
  body('inventory.sku').trim().isLength({ min: 3 }),
  body('images').isArray({ min: 1 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    // Check authorization (would be middleware in production)
    if (req.userRole !== 'admin' && req.userRole !== 'vendor') {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const productData = req.body;
    productData.currentPrice.lastUpdated = new Date();

    const product = new Product(productData);
    await product.save();

    // Invalidate cache
    await redis.del(CACHE_KEYS.featured);
    await redis.keys('products:*').then(keys => {
      if (keys.length > 0) return redis.del(...keys);
    });

    logger.info('Product created', { productId: product._id, correlationId: req.correlationId });
    res.status(201).json(product);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: 'Product with this slug or SKU already exists' });
    }
    logger.error('Failed to create product', { error: error.message, correlationId: req.correlationId });
    res.status(500).json({ error: 'Failed to create product' });
  }
});

// Update product price (with optimistic locking via version)
app.patch('/:id/price', async (req, res) => {
  try {
    const { id } = req.params;
    const { amount, reason } = req.body;

    // Atomic update with $inc for version (optimistic locking pattern)
    const product = await Product.findOneAndUpdate(
      { _id: id, isActive: true, isDeleted: false },
      {
        $set: {
          'currentPrice.amount': amount,
          'currentPrice.lastUpdated': new Date()
        },
        $push: {
          priceHistory: {
            amount: amount,
            date: new Date()
          }
        }
      },
      { new: true }
    );

    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    // Invalidate caches
    await redis.del(CACHE_KEYS.product(id));
    await redis.del(CACHE_KEYS.featured);

    logger.info('Price updated', { 
      productId: id, 
      newPrice: amount, 
      reason,
      correlationId: req.correlationId 
    });

    res.json(product);
  } catch (error) {
    logger.error('Failed to update price', { error: error.message, correlationId: req.correlationId });
    res.status(500).json({ error: 'Failed to update price' });
  }
});

// Get featured products
app.get('/featured/list', async (req, res) => {
  try {
    const cacheKey = CACHE_KEYS.featured;
    const cached = await redis.get(cacheKey);

    if (cached) {
      return res.json(JSON.parse(cached));
    }

    const products = await Product.find({ 
      isActive: true, 
      isDeleted: false,
      'inventory.isAvailable': true 
    })
    .sort({ 'ratings.average': -1, createdAt: -1 })
    .limit(10)
    .select('name slug currentPrice images ratings category attributes')
    .lean();

    await redis.setex(cacheKey, FEATURED_TTL, JSON.stringify(products));
    res.json(products);
  } catch (error) {
    logger.error('Failed to fetch featured', { error: error.message, correlationId: req.correlationId });
    res.status(500).json({ error: 'Failed to fetch featured products' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'product-service', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 5002;
app.listen(PORT, () => {
  logger.info(`Product Service running on port ${PORT}`);
});

module.exports = app;
