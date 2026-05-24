[README.md](https://github.com/user-attachments/files/28197215/README.md)
# VeggieMandala
Full Stack E-Commerce Grocery App
# 🥬 FreshVegetables - Microservices E-Commerce Platform

A production-ready vegetable e-commerce platform built with the MERN stack and microservices architecture. Features daily price updates, real-time inventory management, and scalable distributed systems patterns.

## 🏗️ Architecture Overview

```
┌─────────────┐     ┌─────────────┐     ┌─────────────────┐
│   React     │────▶│   Nginx     │────▶│  API Gateway    │
│  (Port 3000)│     │  (Port 80)  │     │  (Port 5000)    │
└─────────────┘     └─────────────┘     └─────────────────┘
                                               │
                    ┌──────────┬──────────┬────┴────┬──────────┐
                    ▼          ▼          ▼         ▼          ▼
              ┌────────┐ ┌─────────┐ ┌────────┐ ┌────────┐ ┌──────────┐
              │  Auth  │ │ Products│ │ Orders │ │Payment │ │Inventory │
              │(5001)  │ │ (5002)  │ │(5003)  │ │(5005)  │ │ (5004)   │
              └────────┘ └─────────┘ └────────┘ └────────┘ └──────────┘
                    │          │          │         │          │
                    └──────────┴──────────┴────┬────┴──────────┘
                                               │
                                        ┌─────────────┐
                                        │ Notification│
                                        │  (5006)     │
                                        └─────────────┘
                                               │
                    ┌──────────┬──────────┬────┴────┐
                    ▼          ▼          ▼         ▼
              ┌────────┐ ┌─────────┐ ┌────────┐ ┌────────┐
              │MongoDB │ │  Redis  │ │BullMQ  │ │Socket.io│
              │(27017) │ │ (6379)  │ │ Queues │ │ (5006) │
              └────────┘ └─────────┘ └────────┘ └────────┘
```

## 🚀 Quick Start

### Prerequisites
- Docker & Docker Compose
- Node.js 20+ (for local development)
- Git

### 1. Clone and Setup
```bash
git clone <repository-url>
cd vegetable-ecommerce

cp .env.example .env
# Edit .env with your configuration
```

### 2. Start with Docker Compose
```bash
docker-compose up -d
```

This starts all services:
- **Frontend**: http://localhost:3000
- **API Gateway**: http://localhost:5000
- **Nginx Load Balancer**: http://localhost:80
- **MongoDB**: localhost:27017
- **Redis**: localhost:6379

### 3. Seed Sample Data
```bash
node scripts/seed-data.js
```

### 4. Development Mode
```bash
# Terminal 1: Start infrastructure
docker-compose up -d mongodb redis

# Terminal 2: Start services individually
cd api-gateway && npm install && npm run dev
cd auth-service && npm install && npm run dev
cd product-service && npm install && npm run dev
# ... etc

# Terminal 3: Frontend
cd frontend && npm install && npm run dev
```

## 📁 Project Structure

```
vegetable-ecommerce/
├── api-gateway/           # Entry point, auth, rate limiting
├── auth-service/          # JWT, refresh tokens, roles
├── product-service/        # Catalog, caching, search
├── order-service/          # Orders, saga pattern, snapshots
├── inventory-service/     # Stock, atomic updates, reservations
├── payment-service/       # Payments, idempotency, refunds
├── notification-service/  # Email, SMS, Socket.io push
├── frontend/              # React 18, Vite, responsive
├── docker/                # Nginx configs
├── docker-compose.yml     # Full orchestration
└── .env.example          # Environment template
```

## 🔑 Key Features Implemented

### 1. Data Modeling & Consistency
- **Denormalized Price Snapshots**: Order documents store the exact price at purchase time, immune to future price changes
- **Dynamic Schema**: MongoDB allows different attributes per vegetable type (organic, pre-washed, growing substrate)

### 2. Inventory Concurrency & Race Conditions
- **Atomic Updates**: Using `$inc` with `$expr` conditions to prevent overselling
- **Reservation Pattern**: Reserve → Deduct/Release flow for checkout
- **Optimistic Locking**: Version numbers for concurrent admin updates

### 3. Scalability & Performance
- **Redis Cache-Aside**: Product lists cached with TTL, invalidation on updates
- **Cursor-Based Pagination**: No slow `skip()` for large datasets
- **Database Indexing**: Compound indexes, text search, hashed sharding keys

### 4. Media Storage
- **Cloud URLs Only**: Images stored in S3/Cloudinary, URLs saved in MongoDB
- **CDN Ready**: Image URLs support CloudFront/Cloudflare caching
- **No Base64/Buffers**: Avoids 33% size increase and 16MB document limit

### 5. Security
- **JWT Best Practices**: Short-lived access tokens (15min) + refresh tokens (7 days)
- **Token Rotation**: New refresh token issued on every refresh
- **Redis Blacklist**: Token revocation support
- **Rate Limiting**: Redis-based with different tiers for auth vs API
- **CORS**: Configured for specific origins only
- **Helmet**: Security headers

### 6. Asynchronous Processing
- **BullMQ Job Queues**: Background processing for emails, PDFs, notifications
- **Retry with Exponential Backoff**: `2^n * 1000ms + jitter` for failed jobs
- **Persistence**: Jobs survive service restarts

### 7. Distributed Systems
- **Saga Pattern**: Compensating transactions for order failures
- **Circuit Breaker**: Nginx health checks + fail_timeout
- **Service Discovery**: Docker DNS + environment-based URLs
- **API Gateway**: Single entry point with cross-cutting concerns
- **Distributed Tracing**: Correlation IDs passed through all services

### 8. Frontend Performance
- **Debouncing**: 500ms delay on search to prevent API spam
- **Lazy Loading**: Images loaded on demand
- **Socket.io**: Real-time stock alerts and order updates
- **JWT Auto-Refresh**: Silent token renewal via interceptors

## 🧪 API Endpoints

### Authentication
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Register new user |
| POST | `/api/auth/login` | Login with credentials |
| POST | `/api/auth/refresh` | Refresh access token |
| POST | `/api/auth/logout` | Revoke tokens |
| GET | `/api/auth/me` | Get current user |

### Products
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/products` | List products (cursor pagination) |
| GET | `/api/products/:id` | Get single product |
| GET | `/api/products/featured/list` | Featured products |
| POST | `/api/products` | Create product (admin) |
| PATCH | `/api/products/:id/price` | Update price |

### Orders
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/orders` | Create order |
| POST | `/api/orders/:id/pay` | Process payment |
| GET | `/api/orders/:id` | Get order details |
| GET | `/api/orders/user/list` | User order history |
| POST | `/api/orders/:id/cancel` | Cancel order |

### Inventory
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/inventory/check/:sku` | Check stock |
| POST | `/api/inventory/reserve` | Reserve stock |
| POST | `/api/inventory/deduct` | Confirm deduction |
| POST | `/api/inventory/release` | Release reservation |
| POST | `/api/inventory/restock` | Add stock |

## 🔒 Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `JWT_SECRET` | JWT signing key | Yes |
| `JWT_REFRESH_SECRET` | Refresh token secret | Yes |
| `MONGODB_URI` | MongoDB connection string | Yes |
| `REDIS_URL` | Redis connection string | Yes |
| `SMTP_HOST` | Email server host | No |
| `AWS_BUCKET_NAME` | S3 bucket for images | No |
| `STRIPE_SECRET_KEY` | Payment gateway key | No |

## 📊 System Design Interview Topics Covered

✅ Data Modeling & Denormalization  
✅ Inventory Concurrency (Atomic Updates)  
✅ Caching Strategies (Redis Cache-Aside)  
✅ Cloud Storage & CDNs  
✅ Load Balancing & Health Checks  
✅ Message Queues (BullMQ)  
✅ Horizontal vs Vertical Scaling  
✅ SQL vs NoSQL Trade-offs  
✅ JWT Security (Access/Refresh Tokens)  
✅ Database Indexing & Query Optimization  
✅ Rate Limiting Implementation  
✅ Pagination Strategies (Cursor vs Offset)  
✅ WebSockets & Real-time Updates  
✅ Monolith vs Microservices  
✅ Saga Pattern & Distributed Transactions  
✅ Database Sharding Concepts  
✅ Read Replicas for Reporting  
✅ CAP Theorem (AP System)  
✅ API Gateway Pattern  
✅ CORS & Same-Origin Policy  
✅ Debouncing & Throttling  
✅ Optimistic vs Pessimistic Locking  
✅ Distributed Tracing (Correlation IDs)  
✅ Circuit Breaker Pattern  
✅ Service Discovery  
✅ Exponential Backoff & Jitter  
✅ CI/CD Pipeline Concepts  

## 🐳 Docker Commands

```bash
# Start all services
docker-compose up -d

# View logs
docker-compose logs -f api-gateway

# Scale a service
docker-compose up -d --scale api-gateway=3

# Rebuild after changes
docker-compose up -d --build

# Stop everything
docker-compose down -v
```

## 📈 Scaling Guide

### Horizontal Scaling
```bash
# Add more API Gateway instances
docker-compose up -d --scale api-gateway=3

# Nginx automatically load balances with health checks
```

### Database Sharding (Production)
```javascript
// Enable sharding in MongoDB
sh.enableSharding("vegetable_orders");
sh.shardCollection("vegetable_orders.orders", { userId: "hashed" });
```

### Read Replicas
```javascript
// Configure read preference
mongoose.connect(uri, {
  readPreference: 'secondaryPreferred'
});
```

## 🧪 Testing

```bash
# Unit tests
npm test

# Integration tests
docker-compose -f docker-compose.test.yml up

# Load testing (using Artillery)
npm run load-test
```

## 📝 License

MIT License - see LICENSE file for details.

## 🙏 Acknowledgments


