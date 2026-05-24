const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// Connect to MongoDB
mongoose.connect('mongodb://admin:password123@localhost:27017/vegetable_products?authSource=admin');

// Product Schema (simplified for seeding)
const productSchema = new mongoose.Schema({
  name: String,
  slug: String,
  description: String,
  category: String,
  currentPrice: {
    amount: Number,
    currency: { type: String, default: 'INR' },
    unit: { type: String, default: 'kg' }
  },
  inventory: {
    sku: String,
    quantity: Number,
    isAvailable: Boolean
  },
  images: [{ url: String, alt: String, isPrimary: Boolean }],
  attributes: mongoose.Schema.Types.Mixed,
  ratings: {
    average: Number,
    count: Number
  },
  isActive: Boolean,
  createdAt: { type: Date, default: Date.now }
});

const Product = mongoose.model('Product', productSchema);

// Sample vegetable data
const vegetables = [
  {
    name: 'Organic Tomatoes',
    slug: 'organic-tomatoes',
    description: 'Farm-fresh organic tomatoes, perfect for salads and cooking.',
    category: 'nightshades',
    currentPrice: { amount: 45, unit: 'kg' },
    inventory: { sku: 'TOM-001', quantity: 150, isAvailable: true },
    images: [
      { url: 'https://images.unsplash.com/photo-1546094096-0df4bcaaa337?w=400', alt: 'Fresh tomatoes', isPrimary: true }
    ],
    attributes: { isOrganic: true, color: 'red', grade: 'A', origin: 'Maharashtra' },
    ratings: { average: 4.5, count: 128 }
  },
  {
    name: 'Baby Spinach',
    slug: 'baby-spinach',
    description: 'Pre-washed baby spinach leaves, ready to eat.',
    category: 'leafy_greens',
    currentPrice: { amount: 35, unit: 'bunch' },
    inventory: { sku: 'SPI-001', quantity: 80, isAvailable: true },
    images: [
      { url: 'https://images.unsplash.com/photo-1576045057995-568f588f82fb?w=400', alt: 'Baby spinach', isPrimary: true }
    ],
    attributes: { isPreWashed: true, shelfLife: '5 days', bunchSize: '200g' },
    ratings: { average: 4.7, count: 95 }
  },
  {
    name: 'Premium Carrots',
    slug: 'premium-carrots',
    description: 'Sweet and crunchy carrots from local farms.',
    category: 'root_vegetables',
    currentPrice: { amount: 30, unit: 'kg' },
    inventory: { sku: 'CAR-001', quantity: 200, isAvailable: true },
    images: [
      { url: 'https://images.unsplash.com/photo-1598170845058-32b9d6a5da37?w=400', alt: 'Fresh carrots', isPrimary: true }
    ],
    attributes: { isOrganic: true, color: 'orange', grade: 'A', length: '15-20cm' },
    ratings: { average: 4.3, count: 210 }
  },
  {
    name: 'Broccoli Florets',
    slug: 'broccoli-florets',
    description: 'Nutrient-rich broccoli florets, cut and ready.',
    category: 'cruciferous',
    currentPrice: { amount: 60, unit: '500g' },
    inventory: { sku: 'BRO-001', quantity: 45, isAvailable: true },
    images: [
      { url: 'https://images.unsplash.com/photo-1459411621453-7b03977f4bfc?w=400', alt: 'Broccoli', isPrimary: true }
    ],
    attributes: { isOrganic: false, freshness: 'same_day', cutType: 'florets' },
    ratings: { average: 4.6, count: 76 }
  },
  {
    name: 'Red Onions',
    slug: 'red-onions',
    description: 'Sharp and flavorful red onions for cooking.',
    category: 'alliums',
    currentPrice: { amount: 25, unit: 'kg' },
    inventory: { sku: 'ONI-001', quantity: 300, isAvailable: true },
    images: [
      { url: 'https://images.unsplash.com/photo-1618512496248-a07fe83aa8cb?w=400', alt: 'Red onions', isPrimary: true }
    ],
    attributes: { variety: 'red', pungency: 'medium', origin: 'Gujarat' },
    ratings: { average: 4.2, count: 340 }
  },
  {
    name: 'Button Mushrooms',
    slug: 'button-mushrooms',
    description: 'Fresh button mushrooms, perfect for curries and stir-fry.',
    category: 'mushrooms',
    currentPrice: { amount: 80, unit: '200g' },
    inventory: { sku: 'MUS-001', quantity: 60, isAvailable: true },
    images: [
      { url: 'https://images.unsplash.com/photo-1504545102780-26774c1bb073?w=400', alt: 'Button mushrooms', isPrimary: true }
    ],
    attributes: { growingSubstrate: 'straw', variety: 'button', isDried: false },
    ratings: { average: 4.4, count: 112 }
  },
  {
    name: 'Green Bell Peppers',
    slug: 'green-bell-peppers',
    description: 'Crunchy green bell peppers, rich in Vitamin C.',
    category: 'nightshades',
    currentPrice: { amount: 55, unit: 'kg' },
    inventory: { sku: 'PEP-001', quantity: 120, isAvailable: true },
    images: [
      { url: 'https://images.unsplash.com/photo-1563565375-f3fdfdbefa83?w=400', alt: 'Green peppers', isPrimary: true }
    ],
    attributes: { color: 'green', crunchiness: 'high', vitaminC: 'high' },
    ratings: { average: 4.1, count: 89 }
  },
  {
    name: 'Fresh Basil',
    slug: 'fresh-basil',
    description: 'Aromatic fresh basil leaves for Italian and Thai dishes.',
    category: 'herbs',
    currentPrice: { amount: 20, unit: 'bunch' },
    inventory: { sku: 'BAS-001', quantity: 40, isAvailable: true },
    images: [
      { url: 'https://images.unsplash.com/photo-1618375531912-867942df6360?w=400', alt: 'Fresh basil', isPrimary: true }
    ],
    attributes: { aroma: 'strong', variety: 'sweet', shelfLife: '7 days' },
    ratings: { average: 4.8, count: 67 }
  },
  {
    name: 'Butternut Squash',
    slug: 'butternut-squash',
    description: 'Sweet and nutty butternut squash, perfect for soups.',
    category: 'squash',
    currentPrice: { amount: 40, unit: 'piece' },
    inventory: { sku: 'SQU-001', quantity: 35, isAvailable: true },
    images: [
      { url: 'https://images.unsplash.com/photo-1570586437263-e41d14c47a65?w=400', alt: 'Butternut squash', isPrimary: true }
    ],
    attributes: { weight: '1-1.5kg', sweetness: 'high', texture: 'creamy' },
    ratings: { average: 4.5, count: 54 }
  },
  {
    name: 'Green Beans',
    slug: 'green-beans',
    description: 'Crisp and tender green beans, farm fresh.',
    category: 'legumes',
    currentPrice: { amount: 35, unit: '500g' },
    inventory: { sku: 'BEA-001', quantity: 90, isAvailable: true },
    images: [
      { url: 'https://images.unsplash.com/photo-1567375688846-d471f2ad0e1d?w=400', alt: 'Green beans', isPrimary: true }
    ],
    attributes: { crispness: 'high', length: '10-12cm', origin: 'Karnataka' },
    ratings: { average: 4.3, count: 78 }
  }
];

async function seed() {
  try {
    // Clear existing
    await Product.deleteMany({});
    console.log('Cleared existing products');

    // Insert new
    const result = await Product.insertMany(vegetables);
    console.log(`Seeded ${result.length} products`);

    // Also seed inventory in inventory service DB
    const inventoryConn = await mongoose.createConnection(
      'mongodb://admin:password123@localhost:27017/vegetable_inventory?authSource=admin'
    );

    const inventorySchema = new mongoose.Schema({
      sku: String,
      productId: mongoose.Schema.Types.ObjectId,
      productName: String,
      quantity: Number,
      reservedQuantity: Number,
      availableQuantity: Number,
      lowStockThreshold: Number,
      status: String,
      isActive: Boolean
    });

    const Inventory = inventoryConn.model('Inventory', inventorySchema);
    await Inventory.deleteMany({});

    const inventoryItems = result.map(p => ({
      sku: p.inventory.sku,
      productId: p._id,
      productName: p.name,
      quantity: p.inventory.quantity,
      reservedQuantity: 0,
      availableQuantity: p.inventory.quantity,
      lowStockThreshold: 10,
      status: p.inventory.quantity > 10 ? 'in_stock' : 'low_stock',
      isActive: true
    }));

    await Inventory.insertMany(inventoryItems);
    console.log(`Seeded ${inventoryItems.length} inventory records`);

    console.log('\n✅ Database seeded successfully!');
    console.log('\nSample products:');
    result.forEach(p => {
      console.log(`  - ${p.name}: ₹${p.currentPrice.amount}/${p.currentPrice.unit} (${p.inventory.quantity} in stock)`);
    });

  } catch (error) {
    console.error('Seeding failed:', error);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

seed();
