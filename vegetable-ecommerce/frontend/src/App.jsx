import React, { useState, useEffect, useCallback, useRef } from 'react';
import { BrowserRouter as Router, Routes, Route, Link, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { io } from 'socket.io-client';
import './App.css';

// API Configuration
const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:5006';

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: { 'Content-Type': 'application/json' }
});

// Request interceptor - add auth token
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('accessToken');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Response interceptor - handle token refresh
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    if (error.response?.status === 403 && !originalRequest._retry) {
      originalRequest._retry = true;

      try {
        const refreshToken = localStorage.getItem('refreshToken');
        const response = await axios.post(`${API_BASE_URL}/auth/refresh`, { refreshToken });

        const { accessToken, refreshToken: newRefreshToken } = response.data;
        localStorage.setItem('accessToken', accessToken);
        localStorage.setItem('refreshToken', newRefreshToken);

        originalRequest.headers.Authorization = `Bearer ${accessToken}`;
        return api(originalRequest);
      } catch (refreshError) {
        // Refresh failed - logout user
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
        window.location.href = '/login';
        return Promise.reject(refreshError);
      }
    }

    return Promise.reject(error);
  }
);

// ==================== CUSTOM HOOKS ====================

// Debounce Hook
function useDebounce(value, delay) {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      clearTimeout(handler);
    };
  }, [value, delay]);

  return debouncedValue;
}

// Socket Hook
function useSocket() {
  const [socket, setSocket] = useState(null);
  const [notifications, setNotifications] = useState([]);

  useEffect(() => {
    const newSocket = io(SOCKET_URL);
    setSocket(newSocket);

    newSocket.on('connect', () => {
      console.log('Socket connected');
      const userId = localStorage.getItem('userId');
      if (userId) {
        newSocket.emit('authenticate', { userId });
      }
    });

    newSocket.on('order_created', (data) => {
      setNotifications(prev => [...prev, { type: 'success', message: `Order ${data.orderNumber} created!` }]);
    });

    newSocket.on('payment_success', (data) => {
      setNotifications(prev => [...prev, { type: 'success', message: `Payment received for ${data.orderNumber}` }]);
    });

    newSocket.on('low_stock', (data) => {
      setNotifications(prev => [...prev, { type: 'warning', message: `${data.productName} is low on stock!` }]);
    });

    return () => newSocket.close();
  }, []);

  return { socket, notifications, clearNotifications: () => setNotifications([]) };
}

// ==================== COMPONENTS ====================

// Navbar
function Navbar({ user, onLogout }) {
  return (
    <nav className="navbar">
      <div className="nav-brand">
        <Link to="/">🥬 FreshVegetables</Link>
      </div>
      <div className="nav-links">
        <Link to="/products">Products</Link>
        <Link to="/cart">Cart</Link>
        <Link to="/orders">Orders</Link>
        {user ? (
          <>
            <span className="user-name">Hello, {user.name}</span>
            <button onClick={onLogout} className="btn-logout">Logout</button>
          </>
        ) : (
          <Link to="/login">Login</Link>
        )}
      </div>
    </nav>
  );
}

// Notification Toast
function NotificationToast({ notifications, onClear }) {
  if (notifications.length === 0) return null;

  return (
    <div className="notification-container">
      {notifications.map((notif, index) => (
        <div key={index} className={`notification ${notif.type}`}>
          {notif.message}
        </div>
      ))}
      <button onClick={onClear} className="clear-notifications">Clear All</button>
    </div>
  );
}

// Product Card
function ProductCard({ product, onAddToCart }) {
  const primaryImage = product.images?.find(img => img.isPrimary) || product.images?.[0];

  return (
    <div className="product-card">
      <div className="product-image">
        <img 
          src={primaryImage?.url || '/placeholder-vegetable.jpg'} 
          alt={product.name}
          loading="lazy"
        />
        {product.attributes?.isOrganic && <span className="badge organic">Organic</span>}
      </div>
      <div className="product-info">
        <h3>{product.name}</h3>
        <p className="category">{product.category?.replace('_', ' ')}</p>
        <div className="price">
          <span className="current-price">₹{product.currentPrice?.amount}</span>
          <span className="unit">/{product.currentPrice?.unit}</span>
        </div>
        <div className="attributes">
          {Object.entries(product.attributes || {}).slice(0, 3).map(([key, value]) => (
            <span key={key} className="attribute-tag">{key}: {value?.toString()}</span>
          ))}
        </div>
        <button 
          onClick={() => onAddToCart(product)} 
          className="btn-add-cart"
          disabled={product.inventory?.quantity <= 0}
        >
          {product.inventory?.quantity > 0 ? 'Add to Cart' : 'Out of Stock'}
        </button>
      </div>
    </div>
  );
}

// Product List with Search, Pagination, and Debouncing
function ProductList() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Search & Filter State
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('');
  const [sortBy, setSortBy] = useState('createdAt');

  // Pagination State (Cursor-based)
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [nextCursor, setNextCursor] = useState(null);

  const debouncedSearch = useDebounce(searchQuery, 500); // 500ms debounce

  const categories = [
    'leafy_greens', 'root_vegetables', 'cruciferous', 
    'alliums', 'nightshades', 'squash', 'legumes', 'mushrooms', 'herbs'
  ];

  const fetchProducts = useCallback(async (reset = false) => {
    try {
      setLoading(true);

      const params = new URLSearchParams({
        limit: '20',
        sortBy,
        sortOrder: 'desc'
      });

      if (selectedCategory) params.append('category', selectedCategory);
      if (debouncedSearch) params.append('search', debouncedSearch);
      if (!reset && nextCursor) params.append('lastId', nextCursor);

      const response = await api.get(`/products?${params}`);
      const data = response.data;

      if (reset) {
        setProducts(data.products);
        setPage(1);
      } else {
        setProducts(prev => [...prev, ...data.products]);
      }

      setHasMore(data.pagination.hasMore);
      setNextCursor(data.pagination.nextCursor);
      setError(null);
    } catch (err) {
      setError('Failed to load products');
      console.error('Product fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, selectedCategory, sortBy, nextCursor]);

  // Fetch on filter change (with debounce)
  useEffect(() => {
    fetchProducts(true);
  }, [debouncedSearch, selectedCategory, sortBy]);

  const loadMore = () => {
    if (hasMore && !loading) {
      setPage(prev => prev + 1);
      fetchProducts(false);
    }
  };

  const handleAddToCart = (product) => {
    const cart = JSON.parse(localStorage.getItem('cart') || '[]');
    const existing = cart.find(item => item.productId === product._id);

    if (existing) {
      existing.quantity += 1;
    } else {
      cart.push({
        productId: product._id,
        name: product.name,
        price: product.currentPrice.amount,
        quantity: 1,
        image: product.images?.[0]?.url,
        sku: product.inventory?.sku
      });
    }

    localStorage.setItem('cart', JSON.stringify(cart));
    alert(`${product.name} added to cart!`);
  };

  return (
    <div className="product-list-page">
      <div className="filters">
        <div className="search-box">
          <input
            type="text"
            placeholder="Search vegetables..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="search-input"
          />
          {searchQuery && <span className="search-hint">Searching...</span>}
        </div>

        <select 
          value={selectedCategory} 
          onChange={(e) => setSelectedCategory(e.target.value)}
          className="category-select"
        >
          <option value="">All Categories</option>
          {categories.map(cat => (
            <option key={cat} value={cat}>{cat.replace('_', ' ')}</option>
          ))}
        </select>

        <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
          <option value="createdAt">Newest</option>
          <option value="currentPrice.amount">Price</option>
          <option value="ratings.average">Rating</option>
        </select>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="products-grid">
        {products.map(product => (
          <ProductCard key={product._id} product={product} onAddToCart={handleAddToCart} />
        ))}
      </div>

      {loading && <div className="loading">Loading...</div>}

      {hasMore && !loading && (
        <button onClick={loadMore} className="btn-load-more">
          Load More
        </button>
      )}
    </div>
  );
}

// Cart Component
function Cart() {
  const [cart, setCart] = useState([]);
  const navigate = useNavigate();

  useEffect(() => {
    setCart(JSON.parse(localStorage.getItem('cart') || '[]'));
  }, []);

  const updateQuantity = (productId, delta) => {
    const updated = cart.map(item => {
      if (item.productId === productId) {
        return { ...item, quantity: Math.max(1, item.quantity + delta) };
      }
      return item;
    });
    setCart(updated);
    localStorage.setItem('cart', JSON.stringify(updated));
  };

  const removeItem = (productId) => {
    const updated = cart.filter(item => item.productId !== productId);
    setCart(updated);
    localStorage.setItem('cart', JSON.stringify(updated));
  };

  const subtotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  const deliveryFee = subtotal > 500 ? 0 : 40;
  const tax = subtotal * 0.05;
  const total = subtotal + deliveryFee + tax;

  const handleCheckout = () => {
    navigate('/checkout', { state: { cart, pricing: { subtotal, deliveryFee, tax, total } } });
  };

  if (cart.length === 0) {
    return <div className="empty-cart">Your cart is empty</div>;
  }

  return (
    <div className="cart-page">
      <h2>Shopping Cart</h2>
      <div className="cart-items">
        {cart.map(item => (
          <div key={item.productId} className="cart-item">
            <img src={item.image} alt={item.name} />
            <div className="item-details">
              <h4>{item.name}</h4>
              <p>₹{item.price} x {item.quantity}</p>
            </div>
            <div className="item-actions">
              <button onClick={() => updateQuantity(item.productId, -1)}>-</button>
              <span>{item.quantity}</span>
              <button onClick={() => updateQuantity(item.productId, 1)}>+</button>
              <button onClick={() => removeItem(item.productId)} className="remove">×</button>
            </div>
          </div>
        ))}
      </div>

      <div className="cart-summary">
        <div className="summary-row"><span>Subtotal</span><span>₹{subtotal.toFixed(2)}</span></div>
        <div className="summary-row"><span>Delivery</span><span>{deliveryFee === 0 ? 'FREE' : `₹${deliveryFee}`}</span></div>
        <div className="summary-row"><span>Tax (5%)</span><span>₹{tax.toFixed(2)}</span></div>
        <div className="summary-row total"><span>Total</span><span>₹{total.toFixed(2)}</span></div>
        <button onClick={handleCheckout} className="btn-checkout">Proceed to Checkout</button>
      </div>
    </div>
  );
}

// Checkout Component
function Checkout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { cart, pricing } = location.state || {};
  const [loading, setLoading] = useState(false);
  const [address, setAddress] = useState({
    street: '',
    city: '',
    state: '',
    zipCode: ''
  });

  if (!cart || cart.length === 0) {
    return <div>No items to checkout. <Link to="/products">Browse products</Link></div>;
  }

  const handlePlaceOrder = async () => {
    try {
      setLoading(true);

      const orderData = {
        items: cart.map(item => ({
          productId: item.productId,
          quantity: item.quantity
        })),
        deliveryAddress: address,
        paymentMethod: 'cod', // Default to COD for demo
        scheduledDate: new Date(Date.now() + 86400000).toISOString(), // Tomorrow
        timeSlot: 'morning'
      };

      const response = await api.post('/orders', orderData);

      // Clear cart
      localStorage.removeItem('cart');

      alert(`Order placed! Order number: ${response.data.order.orderNumber}`);
      navigate('/orders');
    } catch (error) {
      alert('Failed to place order: ' + (error.response?.data?.error || error.message));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="checkout-page">
      <h2>Checkout</h2>

      <div className="order-summary">
        <h3>Order Summary</h3>
        {cart.map(item => (
          <div key={item.productId} className="checkout-item">
            <span>{item.name} x {item.quantity}</span>
            <span>₹{(item.price * item.quantity).toFixed(2)}</span>
          </div>
        ))}
        <div className="checkout-total">
          <strong>Total: ₹{pricing?.total?.toFixed(2)}</strong>
        </div>
      </div>

      <div className="delivery-form">
        <h3>Delivery Address</h3>
        <input 
          placeholder="Street Address" 
          value={address.street}
          onChange={(e) => setAddress({...address, street: e.target.value})}
        />
        <input 
          placeholder="City" 
          value={address.city}
          onChange={(e) => setAddress({...address, city: e.target.value})}
        />
        <input 
          placeholder="State" 
          value={address.state}
          onChange={(e) => setAddress({...address, state: e.target.value})}
        />
        <input 
          placeholder="PIN Code" 
          value={address.zipCode}
          onChange={(e) => setAddress({...address, zipCode: e.target.value})}
        />
      </div>

      <button 
        onClick={handlePlaceOrder} 
        disabled={loading || !address.street}
        className="btn-place-order"
      >
        {loading ? 'Processing...' : 'Place Order (Cash on Delivery)'}
      </button>
    </div>
  );
}

// Orders List
function Orders() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const { socket } = useSocket();

  useEffect(() => {
    fetchOrders();
  }, []);

  // Subscribe to order updates via Socket.io
  useEffect(() => {
    if (socket) {
      orders.forEach(order => {
        socket.emit('subscribe_order', order._id);
      });
    }
  }, [socket, orders]);

  const fetchOrders = async () => {
    try {
      const response = await api.get('/orders/user/list');
      setOrders(response.data.orders);
    } catch (error) {
      console.error('Failed to fetch orders:', error);
    } finally {
      setLoading(false);
    }
  };

  const getStatusColor = (status) => {
    const colors = {
      pending: 'gray',
      reserved: 'blue',
      paid: 'green',
      packed: 'orange',
      shipped: 'purple',
      delivered: 'green',
      cancelled: 'red'
    };
    return colors[status] || 'gray';
  };

  if (loading) return <div>Loading orders...</div>;

  return (
    <div className="orders-page">
      <h2>My Orders</h2>
      {orders.length === 0 ? (
        <p>No orders yet. <Link to="/products">Start shopping!</Link></p>
      ) : (
        <div className="orders-list">
          {orders.map(order => (
            <div key={order._id} className={`order-card ${getStatusColor(order.status)}`}>
              <div className="order-header">
                <span className="order-number">{order.orderNumber}</span>
                <span className={`status-badge ${order.status}`}>{order.status}</span>
              </div>
              <div className="order-items">
                {order.items?.map((item, idx) => (
                  <div key={idx} className="order-item">
                    <span>{item.name} x {item.quantity}</span>
                    <span>₹{item.totalPrice?.toFixed(2)}</span>
                  </div>
                ))}
              </div>
              <div className="order-footer">
                <span>Total: ₹{order.pricing?.total?.toFixed(2)}</span>
                <span>{new Date(order.createdAt).toLocaleDateString()}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Login Component
function Login() {
  const [isLogin, setIsLogin] = useState(true);
  const [formData, setFormData] = useState({ email: '', password: '', name: '' });
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);

    try {
      const endpoint = isLogin ? '/auth/login' : '/auth/register';
      const response = await api.post(endpoint, formData);

      const { accessToken, refreshToken, user } = response.data;

      localStorage.setItem('accessToken', accessToken);
      localStorage.setItem('refreshToken', refreshToken);
      localStorage.setItem('userId', user.id);
      localStorage.setItem('user', JSON.stringify(user));

      window.location.href = '/';
    } catch (error) {
      alert(error.response?.data?.error || 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h2>{isLogin ? 'Login' : 'Register'}</h2>
        <form onSubmit={handleSubmit}>
          {!isLogin && (
            <input
              placeholder="Full Name"
              value={formData.name}
              onChange={(e) => setFormData({...formData, name: e.target.value})}
              required
            />
          )}
          <input
            type="email"
            placeholder="Email"
            value={formData.email}
            onChange={(e) => setFormData({...formData, email: e.target.value})}
            required
          />
          <input
            type="password"
            placeholder="Password"
            value={formData.password}
            onChange={(e) => setFormData({...formData, password: e.target.value})}
            required
            minLength={6}
          />
          <button type="submit" disabled={loading}>
            {loading ? 'Processing...' : (isLogin ? 'Login' : 'Register')}
          </button>
        </form>
        <p>
          {isLogin ? "Don't have an account? " : "Already have an account? "}
          <button className="link-btn" onClick={() => setIsLogin(!isLogin)}>
            {isLogin ? 'Register' : 'Login'}
          </button>
        </p>
      </div>
    </div>
  );
}

// Home Page
function Home() {
  const [featured, setFeatured] = useState([]);

  useEffect(() => {
    api.get('/products/featured/list')
      .then(res => setFeatured(res.data))
      .catch(console.error);
  }, []);

  return (
    <div className="home-page">
      <div className="hero">
        <h1>Fresh Vegetables Delivered Daily</h1>
        <p>Farm-fresh produce at your doorstep. Prices updated daily based on market rates.</p>
        <Link to="/products" className="btn-primary">Shop Now</Link>
      </div>

      <div className="featured-section">
        <h2>Featured Products</h2>
        <div className="featured-grid">
          {featured.map(product => (
            <ProductCard key={product._id} product={product} onAddToCart={() => {}} />
          ))}
        </div>
      </div>
    </div>
  );
}

// Main App
function App() {
  const [user, setUser] = useState(null);
  const { notifications, clearNotifications } = useSocket();

  useEffect(() => {
    const storedUser = localStorage.getItem('user');
    if (storedUser) {
      setUser(JSON.parse(storedUser));
    }
  }, []);

  const handleLogout = async () => {
    try {
      const refreshToken = localStorage.getItem('refreshToken');
      await api.post('/auth/logout', { refreshToken });
    } catch (e) {
      console.error('Logout error:', e);
    } finally {
      localStorage.clear();
      setUser(null);
      window.location.href = '/';
    }
  };

  return (
    <Router>
      <div className="app">
        <Navbar user={user} onLogout={handleLogout} />
        <NotificationToast notifications={notifications} onClear={clearNotifications} />

        <main className="main-content">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/products" element={<ProductList />} />
            <Route path="/cart" element={<Cart />} />
            <Route path="/checkout" element={<Checkout />} />
            <Route path="/orders" element={<Orders />} />
            <Route path="/login" element={<Login />} />
          </Routes>
        </main>
      </div>
    </Router>
  );
}

export default App;
