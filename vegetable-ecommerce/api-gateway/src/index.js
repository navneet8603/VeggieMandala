const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const Redis = require('ioredis');
const { v4: uuidv4 } = require('uuid');
const winston = require('winston');

const app = express();
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

// Distributed Tracing: Correlation ID
app.use((req, res, next) => {
  req.correlationId = req.headers['x-correlation-id'] || uuidv4();
  res.setHeader('x-correlation-id', req.correlationId);
  next();
});

// Logger with correlation ID
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  defaultMeta: { service: 'api-gateway' },
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'gateway.log' })
  ]
});

app.use((req, res, next) => {
  req.logger = logger.child({ correlationId: req.correlationId });
  next();
});

// Security middleware
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-correlation-id']
}));

app.use(express.json());

// Rate Limiting with Redis store
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
  handler: (req, res) => {
    req.logger.warn('Rate limit exceeded', { ip: req.ip });
    res.status(429).json({ 
      error: 'Too Many Requests',
      message: 'Please slow down your requests',
      retryAfter: 60
    });
  }
});

// Stricter rate limit for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts
  message: 'Too many auth attempts, please try again later'
});

app.use(limiter);

// JWT Authentication middleware
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    // Check if token is blacklisted in Redis
    const isBlacklisted = await redis.get(`blacklist:${token}`);
    if (isBlacklisted) {
      return res.status(403).json({ error: 'Token has been revoked' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
    req.user = decoded;
    req.logger.info('User authenticated', { userId: decoded.userId });
    next();
  } catch (err) {
    req.logger.error('Token verification failed', { error: err.message });
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
};

// Service Registry (Service Discovery)
const services = {
  auth: process.env.AUTH_SERVICE_URL || 'http://localhost:5001',
  products: process.env.PRODUCT_SERVICE_URL || 'http://localhost:5002',
  orders: process.env.ORDER_SERVICE_URL || 'http://localhost:5003',
  inventory: process.env.INVENTORY_SERVICE_URL || 'http://localhost:5004',
  payment: process.env.PAYMENT_SERVICE_URL || 'http://localhost:5005',
  notifications: process.env.NOTIFICATION_SERVICE_URL || 'http://localhost:5006'
};

// Health check endpoint
app.get('/health', async (req, res) => {
  const health = {
    gateway: 'healthy',
    timestamp: new Date().toISOString(),
    services: {}
  };

  for (const [name, url] of Object.entries(services)) {
    try {
      const response = await fetch(`${url}/health`, { timeout: 5000 });
      health.services[name] = response.ok ? 'healthy' : 'unhealthy';
    } catch (err) {
      health.services[name] = 'down';
    }
  }

  const allHealthy = Object.values(health.services).every(s => s === 'healthy');
  res.status(allHealthy ? 200 : 503).json(health);
});

// Proxy middleware with circuit breaker pattern
const createServiceProxy = (serviceName, pathPrefix, requireAuth = true) => {
  const proxy = createProxyMiddleware({
    target: services[serviceName],
    changeOrigin: true,
    pathRewrite: { [`^/api/${pathPrefix}`]: '' },
    onProxyReq: (proxyReq, req) => {
      // Forward correlation ID and user info
      proxyReq.setHeader('x-correlation-id', req.correlationId);
      if (req.user) {
        proxyReq.setHeader('x-user-id', req.user.userId);
        proxyReq.setHeader('x-user-role', req.user.role);
      }
      req.logger.info(`Proxying to ${serviceName}`, { 
        path: req.path,
        method: req.method 
      });
    },
    onError: (err, req, res) => {
      req.logger.error(`Proxy error for ${serviceName}`, { error: err.message });
      res.status(502).json({ 
        error: 'Service temporarily unavailable',
        service: serviceName,
        correlationId: req.correlationId
      });
    }
  });

  return requireAuth ? [authenticateToken, proxy] : proxy;
};

// Routes
app.use('/api/auth', authLimiter, createServiceProxy('auth', 'auth', false));
app.use('/api/products', ...createServiceProxy('products', 'products', false)); // Public browsing
app.use('/api/orders', ...createServiceProxy('orders', 'orders', true));
app.use('/api/inventory', ...createServiceProxy('inventory', 'inventory', true));
app.use('/api/payments', ...createServiceProxy('payment', 'payments', true));
app.use('/api/notifications', ...createServiceProxy('notifications', 'notifications', true));

// Global error handler
app.use((err, req, res, next) => {
  req.logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ 
    error: 'Internal server error',
    correlationId: req.correlationId
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  logger.info(`API Gateway running on port ${PORT}`);
  logger.info(`Services configured: ${Object.keys(services).join(', ')}`);
});

module.exports = app;
