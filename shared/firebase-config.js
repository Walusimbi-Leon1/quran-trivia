/**
 * Firebase configuration for Bible Game
 * 
 * This file is imported by:
 *   - Web app (ES module via CDN import)
 *   - Node.js scripts (require)
 * 
 * The web app uses the Firebase Web SDK directly.
 * Node bots use firebase-admin.
 */

// For the browser - used in web/app.js
export const firebaseConfig = {
  apiKey: "AIzaSyCFi9RGPH6OtVgpktsHgP9qjBFdYoCGsNI",
  authDomain: "bible-game-21.firebaseapp.com",
  projectId: "bible-game-21",
  storageBucket: "bible-game-21.firebasestorage.app",
  messagingSenderId: "974314606890",
  appId: "1:974314606890:web:ab91bebf621193aeae8e53",
  measurementId: "G-FTR8BJHKL8"
};

// Database URL for RTDB
export const databaseURL = "https://bible-game-21-default-rtdb.firebaseio.com";
