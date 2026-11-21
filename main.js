import { initializeApp } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js";

import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const form = document.getElementById("login-form");
const email = document.getElementById("identity");
const password = document.getElementById("password");
const toggle = document.getElementById("toggle-password");
const errorBox = document.getElementById("login-error");
const submit = form.querySelector('button[type="submit"]');

toggle.addEventListener("click", () => {
  const show = password.type === "password";
  password.type = show ? "text" : "password";
  toggle.textContent = show ? "Hide" : "Show";
  toggle.setAttribute("aria-pressed", String(show));
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  submit.disabled = true;

  let signedIn = false;

  try {
    const { user } = await signInWithEmailAndPassword(
      auth, email.value.trim(), password.value
    );
    signedIn = true;

    const profile = await getDoc(doc(db, "users", user.uid));
    const role = profile.data()?.role;

    if (role === "admin") {
      window.location.replace("./admin.html");
    } else if (role === "customer") {
      window.location.replace("./customer.html");
    } else {
      throw new Error("The user profile is missing or has an invalid role.");
    }
  } catch (error) {
    if (signedIn) await signOut(auth).catch(console.error);

    errorBox.textContent = signedIn
      ? "Your login worked, but your account role could not be loaded."
      : "Unable to sign in. Check your email and password and try again.";
    errorBox.hidden = false;
    console.error("Login failed:", error.code ?? error.message);
  } finally {
    submit.disabled = false;
  }
});