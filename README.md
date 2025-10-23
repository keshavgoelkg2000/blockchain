# Blockchain Explorer & Validator (Assignment 3)

A web-based, interactive application that demonstrates the core concepts of a simple **Proof-of-Work blockchain** with Bitcoin-style transactions.  
Each mined block now contains a **coinbase transaction** and 5 randomly generated transactions, all structured in the **Bitcoin transaction format**.  
The block header also includes a **Merkle Root**, computed from all transaction IDs.

---

## Features
- Visualize a blockchain with block headers and transactions  
- Transactions shown in **Bitcoin format** (Version, Inputs, Outputs, Locktime)  
- Each block contains:
  - A **coinbase transaction** (reward to miner)  
  - Five randomly generated transactions spending real UTXOs  
- **Merkle Root** included in the block header  
- Mine new blocks with Proof-of-Work (SHA-256)  
- Validate the integrity of an uploaded blockchain file  

---

## Technical Details

### Backend
- **Runtime:** Node.js  
- **Framework:** Express.js  

### Frontend
- **Technologies:** HTML5, CSS3, JavaScript  

### Blockchain Logic
- **Hashing Algorithm:** SHA-256 (double SHA-256 for txid & merkle tree)  
- **Block Hash:** Generated from header fields:  
  - Block index  
  - Timestamp  
  - Previous block’s hash  
  - Merkle Root  
  - Nonce (Proof-of-Work)  

---

## Getting Started

### Prerequisites
- Install [Node.js](https://nodejs.org/) (includes npm)

### Installation & Setup

Clone the repository:

```bash
git clone https://github.com/keshavgoelkg2000/blockchain.git
```

Install Dependencies:
 
```bash
npm install
```
```bash
npm install express
```
```bash
npm install mutler
```

Run the server:
```bash
node server.js
```

Open the application:
The terminal will display:

```bash
Server is running on http://localhost:8080
```

Navigate to http://localhost:8080 in your browser.
