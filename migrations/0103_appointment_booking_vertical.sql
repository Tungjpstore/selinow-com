PRAGMA foreign_keys = ON;

-- Appointment booking vertical (TV4). Additive only, mirroring the 0102
-- strategy: no parent table is rebuilt. A bookable service is a product whose
-- variant carries duration_minutes; goods shipping (0102) stays untouched.

-- Variant = service duration for bookable services (NULL for every existing row).
ALTER TABLE product_variants ADD COLUMN duration_minutes INTEGER
  CHECK (duration_minutes IS NULL OR (duration_minutes >= 5 AND duration_minutes <= 720));

-- Staff / rooms that take appointments.
CREATE TABLE booking_resources (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  role_label TEXT CHECK (role_label IS NULL OR length(role_label) BETWEEN 2 AND 80),
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id, id)
) STRICT;

CREATE INDEX idx_booking_resources_shop
  ON booking_resources(shop_id, status, name, id);

CREATE TRIGGER booking_resources_identity_immutable
BEFORE UPDATE ON booking_resources
WHEN
  NEW.id != OLD.id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'booking_resources_identity_immutable');
END;

-- Weekly availability template per resource, minutes from local midnight.
CREATE TABLE booking_resource_schedules (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  resource_id TEXT NOT NULL,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_minute INTEGER NOT NULL CHECK (start_minute >= 0 AND start_minute < 1440),
  end_minute INTEGER NOT NULL CHECK (end_minute > 0 AND end_minute <= 1440 AND end_minute > start_minute),
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id, resource_id) REFERENCES booking_resources(shop_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX idx_booking_resource_schedules_resource
  ON booking_resource_schedules(shop_id, resource_id, status, weekday, start_minute);

CREATE TRIGGER booking_resource_schedules_identity_immutable
BEFORE UPDATE ON booking_resource_schedules
WHEN
  NEW.id != OLD.id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.resource_id != OLD.resource_id
  OR NEW.weekday != OLD.weekday
  OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'booking_resource_schedules_identity_immutable');
END;

-- Short-lived slot holds created inside the checkout transaction (the token
-- marks this batch's rows, mirroring inventory keys and physical stock).
CREATE TABLE booking_holds (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  resource_id TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  hold_token TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'released')),
  released_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (shop_id, id),
  CHECK ((status = 'released') = (released_at IS NOT NULL)),
  FOREIGN KEY (shop_id, resource_id) REFERENCES booking_resources(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, variant_id) REFERENCES product_variants(shop_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX idx_booking_holds_overlap
  ON booking_holds(shop_id, resource_id, status, start_at, end_at);

CREATE TRIGGER booking_holds_identity_immutable
BEFORE UPDATE ON booking_holds
WHEN
  NEW.id != OLD.id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.resource_id != OLD.resource_id
  OR NEW.variant_id != OLD.variant_id
  OR NEW.hold_token != OLD.hold_token
  OR NEW.start_at != OLD.start_at
  OR NEW.end_at != OLD.end_at
  OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'booking_holds_identity_immutable');
END;

CREATE TRIGGER booking_holds_transition_guard
BEFORE UPDATE ON booking_holds
WHEN NOT (
  (OLD.status = 'active' AND NEW.status IN ('active', 'released'))
  OR (OLD.status = 'released' AND NEW.status = 'released')
)
BEGIN
  SELECT RAISE(ABORT, 'booking_holds_transition_invalid');
END;

-- Confirmed appointments, created when the order is paid (booking flow marks
-- paid orders fulfilled by the booking itself; cancellation is seller-side).
CREATE TABLE bookings (
  id TEXT PRIMARY KEY NOT NULL,
  shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
  order_id TEXT NOT NULL,
  order_item_id TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('booked', 'cancelled', 'completed', 'no_show')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  cancelled_at TEXT,
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, order_id, order_item_id),
  CHECK ((status IN ('cancelled', 'no_show')) = (cancelled_at IS NOT NULL)),
  FOREIGN KEY (shop_id, order_id) REFERENCES orders(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, order_item_id) REFERENCES order_items(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, variant_id) REFERENCES product_variants(shop_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (shop_id, resource_id) REFERENCES booking_resources(shop_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX idx_bookings_shop_start
  ON bookings(shop_id, start_at, id);

CREATE INDEX idx_bookings_resource_start
  ON bookings(shop_id, resource_id, start_at, end_at);

CREATE TRIGGER bookings_identity_immutable
BEFORE UPDATE ON bookings
WHEN
  NEW.id != OLD.id
  OR NEW.shop_id != OLD.shop_id
  OR NEW.order_id != OLD.order_id
  OR NEW.order_item_id != OLD.order_item_id
  OR NEW.variant_id != OLD.variant_id
  OR NEW.resource_id != OLD.resource_id
  OR NEW.start_at != OLD.start_at
  OR NEW.end_at != OLD.end_at
  OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'bookings_identity_immutable');
END;

CREATE TRIGGER bookings_transition_guard
BEFORE UPDATE ON bookings
WHEN NOT (
  (OLD.status = 'booked' AND NEW.status IN ('booked', 'cancelled', 'completed', 'no_show'))
  OR (OLD.status = 'cancelled' AND NEW.status = 'cancelled')
  OR (OLD.status = 'completed' AND NEW.status = 'completed')
  OR (OLD.status = 'no_show' AND NEW.status = 'no_show')
)
BEGIN
  SELECT RAISE(ABORT, 'bookings_transition_invalid');
END;
