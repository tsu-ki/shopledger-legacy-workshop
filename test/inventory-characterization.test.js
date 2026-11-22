var test = require('node:test');
var assert = require('node:assert/strict');
var inventory = require('../lib/inventory');
var orders = require('../lib/orders');
var dates = require('../lib/dates');
var store = require('../lib/store');

// Synthetic fixtures only. Loading store defines its functions without file I/O.
// Fail immediately if a tested path starts invoking persistence.
test.beforeEach(function (t) {
  function rejectPersistence() {
    assert.fail('Tests must not read or write the application database');
  }
  t.mock.method(store, 'read', rejectPersistence);
  t.mock.method(store, 'write', rejectPersistence);
});

// Remaining CURRENT BEHAVIOUR cases document behaviour outside this ticket.
function clone(value) {
  return structuredClone(value);
}

function cancellationDb() {
  return {
    products: [
      { id: 1, name: 'Test ghee', stock: 1, reserved: 0 },
      { id: 2, name: 'Test oil', stock: 8, reserved: 3 }
    ],
    orders: [{
      id: 41,
      status: 'pending',
      paymentMode: 'khata',
      customerId: 7,
      total: 125,
      items: [{ id: 1, qty: 2 }, { id: 2, qty: 1 }]
    }],
    customers: [{
      id: 7,
      openingBalance: 20,
      totalBilled: 200,
      totalSettled: 50,
      balance: 170
    }]
  };
}

test('sellable stock subtracts reservations, converts numeric strings, and floors at zero', function () {
  [
    { product: { stock: 4, reserved: 3 }, expected: 1 },
    { product: { stock: '4', reserved: '3' }, expected: 1 },
    { product: { stock: 2, reserved: 3 }, expected: 0 },
    { product: { stock: 0, reserved: 0 }, expected: 0 },
    { product: { stock: 3 }, expected: 3 },
    { product: {}, expected: 0 },
    { product: null, expected: 0 }
  ].forEach(function (example) {
    assert.equal(inventory.getSellableStock(example.product), example.expected);
  });
});

[
  { name: 'the last physical unit with no reservations', stock: 1, reserved: 0, qty: 1 },
  { name: 'the last sellable unit with three reserved units', stock: 4, reserved: 3, qty: 1 },
  { name: 'the exact remaining sellable quantity greater than one', stock: 8, reserved: 2, qty: 6 }
].forEach(function (example) {
  test('stock check accepts ' + example.name, function () {
    var product = { id: 1, name: 'Test product', stock: example.stock, reserved: example.reserved };
    var before = clone(product);

    assert.deepEqual(inventory.check([product], [{ id: 1, qty: example.qty }]), { ok: true });
    assert.deepEqual(product, before);
  });
});

test('stock check accepts a quantity below the sellable limit without deducting stock', function () {
  var products = [{ id: 1, name: 'Test product', stock: 8, reserved: 2 }];
  var before = clone(products);

  assert.deepEqual(inventory.check(products, [{ id: '1', qty: 5 }]), { ok: true });
  assert.deepEqual(products, before);
});

[
  { name: 'a quantity above sellable stock', stock: 4, reserved: 3, qty: 2, sellable: 1 },
  { name: 'an empty SKU', stock: 0, reserved: 0, qty: 1, sellable: 0 },
  { name: 'a fully reserved SKU', stock: 4, reserved: 4, qty: 1, sellable: 0 }
].forEach(function (example) {
  test('stock check rejects ' + example.name, function () {
    var products = [{ id: 1, name: 'Test product', stock: example.stock, reserved: example.reserved }];
    var before = clone(products);

    assert.deepEqual(inventory.check(products, [{ id: 1, qty: example.qty }]), {
      ok: false,
      msg: 'Test product is out of stock (' + example.sellable + ' sellable available)'
    });
    assert.deepEqual(products, before);
  });
});

test('stock check rejects an unknown product without mutating earlier valid lines', function () {
  var products = [{ id: 1, name: 'Test product', stock: 8, reserved: 2 }];
  var before = clone(products);

  assert.deepEqual(inventory.check(products, [{ id: 1, qty: 1 }, { id: 999, qty: 1 }]), {
    ok: false,
    msg: 'Unknown product 999'
  });
  assert.deepEqual(products, before);
});

test('empty item lists pass the inventory check and leave stock unchanged', function () {
  var products = [{ id: 1, name: 'Test product', stock: 8, reserved: 2 }];
  var before = clone(products);

  assert.deepEqual(inventory.check(products, []), { ok: true });
  inventory.reserve(products, []);
  inventory.release(products, []);
  assert.deepEqual(products, before);
});

test('stock check rejects duplicate product lines whose combined quantity exceeds sellable stock', function () {
  var products = [{ id: 1, name: 'Test product', stock: 5, reserved: 3 }];
  var items = [{ id: 1, qty: 1 }, { id: '1', qty: 1 }, { id: 1, qty: 1 }];
  var before = clone(products);

  assert.equal(inventory.getSellableStock(products[0]), 2);
  assert.deepEqual(inventory.check(products, items), {
    ok: false,
    msg: 'Test product is out of stock (2 sellable available)'
  });
  assert.deepEqual(products, before);
});

test('reserve deducts physical stock and leaves wholesale reservations unchanged', function () {
  var products = [{ id: 1, name: 'Test product', stock: 8, reserved: 2 }];

  inventory.reserve(products, [{ id: '1', qty: '2' }]);

  assert.equal(products[0].stock, 6);
  assert.equal(products[0].reserved, 2);
  assert.equal(inventory.getSellableStock(products[0]), 4);
});

test('CURRENT BEHAVIOUR: reserve silently skips unknown products and continues', function () {
  var products = [{ id: 1, name: 'Test product', stock: 8, reserved: 2 }];

  inventory.reserve(products, [{ id: 999, qty: 100 }, { id: 1, qty: 2 }]);

  assert.deepEqual(products, [{ id: 1, name: 'Test product', stock: 6, reserved: 2 }]);
});

test('release restores physical stock for saved order lines keyed by id', function () {
  var products = [{ id: 1, name: 'Test product', stock: '8', reserved: 3 }];

  inventory.release(products, [{ id: 1, qty: '2' }]);

  assert.deepEqual(products, [{ id: 1, name: 'Test product', stock: 10, reserved: 3 }]);
});

test('release ignores productId-only lines without changing stock or reservations', function () {
  var products = [{ id: 1, name: 'Test product', stock: 8, reserved: 3 }];
  var before = clone(products);

  inventory.release(products, [{ productId: '1', qty: '2' }]);
  inventory.release(products, [{ productId: 1, qty: 5 }]);

  assert.deepEqual(products, before);
});

test('release skips unknown ids and leaves wholesale reservations unchanged, including absent values', function () {
  var products = [
    { id: 1, name: 'Test product', stock: 8, reserved: 3 },
    { id: 2, name: 'Unreserved product', stock: 5 },
    { id: 3, name: 'Product without stock', reserved: 1 }
  ];

  inventory.release(products, [
    { productId: 1, qty: 100 },
    { id: 999, qty: 100 },
    { id: '1', qty: '1' },
    { id: 2, qty: 1 },
    { id: 3, qty: 2 }
  ]);

  assert.deepEqual(products, [
    { id: 1, name: 'Test product', stock: 9, reserved: 3 },
    { id: 2, name: 'Unreserved product', stock: 6 },
    { id: 3, name: 'Product without stock', stock: 2, reserved: 1 }
  ]);
});

test('inventory summary uses sellable stock for health and physical stock for valuation', function () {
  var products = [
    { stock: 0, price: 9, reorderLevel: 2 },
    { stock: 5, reserved: 5, price: 10, reorderLevel: 1 },
    { stock: 6, reserved: 2, price: 2.5, reorderLevel: 4 },
    { stock: 11, reserved: 0, price: 3, reorderLevel: 10 },
    { stock: 8, price: 1.25 },
    {}
  ];
  var before = clone(products);

  assert.deepEqual(inventory.summarize(products), {
    totalSkus: 6, outOfStockCount: 3, lowStockCount: 2, totalValuation: 108
  });
  assert.deepEqual(products, before);
});

test('inventory summary handles an empty catalog and rounds valuation to two decimals', function () {
  assert.deepEqual(inventory.summarize([]), {
    totalSkus: 0, outOfStockCount: 0, lowStockCount: 0, totalValuation: 0
  });
  assert.deepEqual(inventory.summarize([
    { stock: 3, price: 0.1, reorderLevel: 1 },
    { stock: 2, price: 0.2, reorderLevel: 1 }
  ]), {
    totalSkus: 2, outOfStockCount: 0, lowStockCount: 0, totalValuation: 0.7
  });
  assert.deepEqual(inventory.summarize([{ stock: 3, price: 0.333, reorderLevel: 1 }]), {
    totalSkus: 1, outOfStockCount: 0, lowStockCount: 0, totalValuation: 1
  });
});

test('CURRENT BEHAVIOUR: a zero reorder level falls back to the configured default', function () {
  assert.deepEqual(inventory.summarize([{ stock: 3, price: 2, reorderLevel: 0 }]), {
    totalSkus: 1, outOfStockCount: 0, lowStockCount: 1, totalValuation: 6
  });
});

['pending', 'completed'].forEach(function (status) {
  test('cancelling a ' + status + ' Khata order restores stock and reverses its debit', function (t) {
    var db = cancellationDb();
    db.orders[0].status = status;
    var beforeItems = clone(db.orders[0].items);
    t.mock.method(dates, 'today', function () { return '16/08/2024'; });
    var release = inventory.release;
    var releaseSpy = t.mock.method(inventory, 'release', function (products, items) {
      return release(products, items);
    });

    var result = orders.cancel(db, '41', 'Customer request');

    assert.equal(releaseSpy.mock.callCount(), 1);
    assert.equal(releaseSpy.mock.calls[0].arguments[0], db.products);
    assert.equal(releaseSpy.mock.calls[0].arguments[1], db.orders[0].items);
    assert.equal(result.ok, true);
    assert.equal(result.order, db.orders[0]);
    assert.equal(result.order.status, 'cancelled');
    assert.equal(result.order.cancelledAt, '16/08/2024');
    assert.equal(result.order.cancelReason, 'Customer request');
    assert.deepEqual(result.order.items, beforeItems);
    assert.deepEqual(db.products, [
      { id: 1, name: 'Test ghee', stock: 3, reserved: 0 },
      { id: 2, name: 'Test oil', stock: 9, reserved: 3 }
    ]);
    assert.deepEqual(db.customers[0], {
      id: 7, openingBalance: 20, totalBilled: 75, totalSettled: 50, balance: 45
    });
  });
});

test('cancelling a cash order restores stock without changing the customer ledger', function () {
  var db = cancellationDb();
  db.orders[0].paymentMode = 'cash';
  var beforeCustomers = clone(db.customers);

  var result = orders.cancel(db, 41);

  assert.equal(result.ok, true);
  assert.equal(result.order.status, 'cancelled');
  assert.equal(result.order.cancelReason, 'Cancelled by operator');
  assert.deepEqual(db.products, [
    { id: 1, name: 'Test ghee', stock: 3, reserved: 0 },
    { id: 2, name: 'Test oil', stock: 9, reserved: 3 }
  ]);
  assert.deepEqual(db.customers, beforeCustomers);
});

test('a repeated cancellation is rejected without another Khata reversal or any other mutation', function () {
  var db = cancellationDb();
  assert.equal(orders.cancel(db, 41, 'First request').ok, true);
  var afterFirstCancellation = clone(db);

  assert.deepEqual(orders.cancel(db, 41, 'Second request'), {
    ok: false,
    error: 'Order #41 is already cancelled'
  });
  assert.deepEqual(db, afterFirstCancellation);
});

test('cancelling an unknown order is rejected without any mutation', function () {
  var db = cancellationDb();
  var before = clone(db);

  assert.deepEqual(orders.cancel(db, 999), { ok: false, error: 'Order not found' });
  assert.deepEqual(db, before);
});

test('selling and cancelling the exact sellable quantity across duplicate lines restores stock only once', function () {
  var db = {
    nextOrderId: 41,
    products: [{ id: 1, name: 'Test product', stock: '3', reserved: 1 }],
    orders: [],
    customers: []
  };
  var items = [{ id: 1, qty: 1 }, { id: '1', qty: '1' }];

  assert.deepEqual(inventory.check(db.products, items), { ok: true });
  inventory.reserve(db.products, items);
  assert.deepEqual(db.products, [{ id: 1, name: 'Test product', stock: 1, reserved: 1 }]);
  assert.equal(inventory.check(db.products, [{ id: 1, qty: 1 }]).ok, false);

  var order = orders.add(db, { items: items, total: 20 });
  assert.equal(orders.cancel(db, order.id).ok, true);
  assert.deepEqual(db.products, [{ id: 1, name: 'Test product', stock: 3, reserved: 1 }]);
  var afterCancellation = clone(db);
  assert.equal(orders.cancel(db, order.id).ok, false);
  assert.deepEqual(db, afterCancellation);
});
