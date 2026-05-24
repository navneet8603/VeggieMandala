const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
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
  defaultMeta: { service: 'auth-service' },
  transports: [new winston.transports.Console()]
});

app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/vegetable_auth', {
  useNewUrlParser: true,
  useUnifiedTopology: true
});

// User Schema with role-based access
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true },
  password: { type: String, required: true },
  name: { type: String, required: true },
  role: { 
    type: String, 
    enum: ['customer', 'admin', 'vendor', 'delivery_partner'], 
    default: 'customer' 
  },
  phone: String,
  address: {
    street: String,
    city: String,
    state: String,
    zipCode: String,
    coordinates: {
      lat: Number,
      lng: Number
    }
  },
  isActive: { type: Boolean, default: true },
  lastLogin: Date,
  createdAt: { type: Date, default: Date.now }
});

// Index for faster queries
userSchema.index({ email: 1 });
userSchema.index({ role: 1 });

const User = mongoose.model('User', userSchema);

// Refresh Token Schema (stored in DB for revocation capability)
const refreshTokenSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  token: { type: String, required: true, unique: true },
  expiresAt: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now },
  isRevoked: { type: Boolean, default: false }
});

refreshTokenSchema.index({ token: 1 });
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL index

const RefreshToken = mongoose.model('RefreshToken', refreshTokenSchema);

// JWT Configuration
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'your-refresh-secret-key';
const ACCESS_TOKEN_EXPIRY = '15m';  // Short-lived for security
const REFRESH_TOKEN_EXPIRY = '7d';  // Longer-lived, stored in httpOnly cookie

// Generate tokens
const generateTokens = async (user) => {
  const payload = {
    userId: user._id,
    email: user.email,
    role: user.role,
    name: user.name
  };

  const accessToken = jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });

  const refreshToken = jwt.sign(
    { userId: user._id, tokenType: 'refresh' }, 
    JWT_REFRESH_SECRET, 
    { expiresIn: REFRESH_TOKEN_EXPIRY }
  );

  // Store refresh token in DB for revocation
  await RefreshToken.create({
    userId: user._id,
    token: refreshToken,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  });

  // Also store in Redis for quick lookup
  await redis.setex(`refresh:${user._id}`, 7 * 24 * 60 * 60, refreshToken);

  return { accessToken, refreshToken };
};

// Middleware to extract correlation ID
const traceMiddleware = (req, res, next) => {
  req.correlationId = req.headers['x-correlation-id'] || 'unknown';
  next();
};

app.use(traceMiddleware);

// Register endpoint
app.post('/register', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
  body('name').trim().isLength({ min: 2 }),
  body('role').optional().isIn(['customer', 'vendor'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password, name, role = 'customer', phone, address } = req.body;

    // Check if user exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(409).json({ error: 'User already exists' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(12);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Create user
    const user = new User({
      email,
      password: hashedPassword,
      name,
      role,
      phone,
      address
    });

    await user.save();
    logger.info('User registered', { userId: user._id, email, correlationId: req.correlationId });

    // Generate tokens
    const tokens = await generateTokens(user);

    res.status(201).json({
      message: 'User registered successfully',
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        role: user.role
      },
      ...tokens
    });
  } catch (error) {
    logger.error('Registration failed', { error: error.message, correlationId: req.correlationId });
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login endpoint
app.post('/login', [
  body('email').isEmail(),
  body('password').exists()
], async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email, isActive: true });
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Update last login
    user.lastLogin = new Date();
    await user.save();

    const tokens = await generateTokens(user);

    logger.info('User logged in', { userId: user._id, correlationId: req.correlationId });

    res.json({
      message: 'Login successful',
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        role: user.role
      },
      ...tokens
    });
  } catch (error) {
    logger.error('Login failed', { error: error.message, correlationId: req.correlationId });
    res.status(500).json({ error: 'Login failed' });
  }
});

// Refresh token endpoint
app.post('/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(401).json({ error: 'Refresh token required' });
    }

    // Verify refresh token
    const decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET);

    // Check if token exists and is not revoked
    const storedToken = await RefreshToken.findOne({ 
      token: refreshToken, 
      isRevoked: false 
    });

    if (!storedToken) {
      return res.status(403).json({ error: 'Invalid refresh token' });
    }

    // Get user
    const user = await User.findById(decoded.userId);
    if (!user || !user.isActive) {
      return res.status(403).json({ error: 'User not found or inactive' });
    }

    // Revoke old refresh token (rotation for security)
    storedToken.isRevoked = true;
    await storedToken.save();

    // Generate new tokens
    const tokens = await generateTokens(user);

    logger.info('Token refreshed', { userId: user._id, correlationId: req.correlationId });

    res.json({
      message: 'Token refreshed',
      ...tokens
    });
  } catch (error) {
    logger.error('Token refresh failed', { error: error.message, correlationId: req.correlationId });
    res.status(403).json({ error: 'Invalid refresh token' });
  }
});

// Logout endpoint (token revocation)
app.post('/logout', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    const { refreshToken } = req.body;

    // Blacklist access token in Redis until expiry
    if (token) {
      const decoded = jwt.decode(token);
      if (decoded && decoded.exp) {
        const ttl = decoded.exp - Math.floor(Date.now() / 1000);
        if (ttl > 0) {
          await redis.setex(`blacklist:${token}`, ttl, 'true');
        }
      }
    }

    // Revoke refresh token
    if (refreshToken) {
      await RefreshToken.findOneAndUpdate(
        { token: refreshToken },
        { isRevoked: true }
      );
    }

    logger.info('User logged out', { correlationId: req.correlationId });
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    logger.error('Logout failed', { error: error.message, correlationId: req.correlationId });
    res.status(500).json({ error: 'Logout failed' });
  }
});

// Get current user
app.get('/me', async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.userId).select('-password');

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ user });
  } catch (error) {
    res.status(403).json({ error: 'Invalid token' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'auth-service', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => {
  logger.info(`Auth Service running on port ${PORT}`);
});

module.exports = app;
