CREATE DATABASE IF NOT EXISTS stock_inventory;
USE stock_inventory;

CREATE TABLE IF NOT EXISTS items (
  item_code VARCHAR(50) PRIMARY KEY,
  item_name VARCHAR(150) NOT NULL,
  category VARCHAR(80),
  min_stock INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stock_in (
  id INT AUTO_INCREMENT PRIMARY KEY,
  in_date DATE NOT NULL,
  item_code VARCHAR(50) NOT NULL,
  item_name VARCHAR(150) NOT NULL,
  category VARCHAR(80),
  vendor VARCHAR(150),
  qty_received INT NOT NULL,
  unit_cost DECIMAL(12,2) NOT NULL DEFAULT 0,
  location VARCHAR(100),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (item_code) REFERENCES items(item_code)
);

CREATE TABLE IF NOT EXISTS stock_out (
  id INT AUTO_INCREMENT PRIMARY KEY,
  out_date DATE NOT NULL,
  employee_id VARCHAR(50) NOT NULL,
  employee_name VARCHAR(150) NOT NULL,
  item_code VARCHAR(50) NOT NULL,
  item_name VARCHAR(150) NOT NULL,
  qty INT NOT NULL,
  location VARCHAR(100),
  remarks VARCHAR(255),
  return_required TINYINT(1) NOT NULL DEFAULT 0,
  return_date DATE NULL,
  returned_qty INT NOT NULL DEFAULT 0,
  returned_at DATETIME NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (item_code) REFERENCES items(item_code)
);