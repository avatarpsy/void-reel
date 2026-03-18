import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyCsrhvcQPWIBhtkZbnP-yASJ6t7eOvHqSg",
  authDomain: "voidspace-v1.firebaseapp.com",
  projectId: "voidspace-v1",
  storageBucket: "voidspace-v1.appspot.com",
  messagingSenderId: "140263423615",
  appId: "1:140263423615:web:dd3ba582bd09915bca094a",
  measurementId: "G-406K622DGQ",
};

// Reuse existing Firebase app if already initialized (shared auth with parent page)
const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
export { app };
