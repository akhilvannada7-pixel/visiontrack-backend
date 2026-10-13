require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "../frontend")));

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "visiontrack",
  waitForConnections: true,
  connectionLimit: 10
});

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", database: "connected" });
  } catch (_error) {
    res.status(503).json({ status: "error", database: "unavailable" });
  }
});

app.get("/api/dashboard", async (_req, res) => {
  try {
    const [[objectsCount]] = await pool.query("SELECT COUNT(*) AS total FROM object_tracks");
    const [[sessionsCount]] = await pool.query("SELECT COUNT(*) AS total FROM tracking_sessions");
    const [[eventsCount]] = await pool.query("SELECT COUNT(*) AS total FROM detection_events");
    const [objects] = await pool.query(
      "SELECT track_id, object_class, confidence, x_position, y_position FROM object_tracks ORDER BY created_at DESC LIMIT 25"
    );
    res.json({
      objectCount: objectsCount.total,
      sessionCount: sessionsCount.total,
      eventCount: eventsCount.total,
      objects
    });
  } catch (error) {
    console.error("Dashboard query failed:", error.message);
    res.status(500).json({ error: "Could not load dashboard. Check database setup." });
  }
});

app.post("/api/objects", async (req, res) => {
  const { objectClass, confidence, xPosition, yPosition } = req.body || {};
  const validClasses = ["Person", "Vehicle", "Bicycle", "Other"];
  if (!validClasses.includes(objectClass) ||
      !Number.isFinite(confidence) || confidence < 0 || confidence > 100 ||
      !Number.isFinite(xPosition) || xPosition < 0 || xPosition > 100 ||
      !Number.isFinite(yPosition) || yPosition < 0 || yPosition > 100) {
    return res.status(400).json({ error: "Provide a valid class, confidence (0–100), and positions (0–100)." });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [sessionRows] = await connection.query(
      "SELECT session_id FROM tracking_sessions WHERE ended_at IS NULL ORDER BY session_id DESC LIMIT 1"
    );
    let sessionId;
    if (sessionRows.length) {
      sessionId = sessionRows[0].session_id;
    } else {
      const [sessionResult] = await connection.query(
        "INSERT INTO tracking_sessions (source_name) VALUES (?)", ["Manual demo entry"]
      );
      sessionId = sessionResult.insertId;
    }
    const [trackResult] = await connection.query(
      "INSERT INTO object_tracks (session_id, object_class, confidence, x_position, y_position) VALUES (?, ?, ?, ?, ?)",
      [sessionId, objectClass, confidence, xPosition, yPosition]
    );
    await connection.query(
      "INSERT INTO detection_events (track_id, event_type, x_position, y_position) VALUES (?, ?, ?, ?)",
      [trackResult.insertId, "Manual demo entry", xPosition, yPosition]
    );
    await connection.commit();
    res.status(201).json({ message: "Tracking record saved", trackId: trackResult.insertId, sessionId });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error("Insert failed:", error.message);
    res.status(500).json({ error: "Could not save record. Check database setup." });
  } finally {
    if (connection) connection.release();
  }
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`VisionTrack API running at http://localhost:${port}`));
