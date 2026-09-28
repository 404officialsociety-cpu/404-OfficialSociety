import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

declare global {
  interface Window {
    google?: any;
    Cashfree?: any;
  }
}

type Product = {
  id: string;
  handle: string;
  title: string;
  description: string;
  image?: string;
  price: number;
  compareAtPrice?: number | null;
  currency: string;
  available: boolean;
  variantId: string;
  options: { name: string; value: string }[];
};

type User = { sub: string; email: string; name: string; picture?: string };

const money = (n: number, currency = "INR") =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(n);

function App() {
  const [products, setProducts] = useState<Product[]>([]);
  const [user, setUser] = useState<User | null>(null);
  const [cart, setCart] = useState<Record<string, number>>({});
  const [drawer, setDrawer] = useState(false);
  const [login, setLogin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const cartItems = useMemo(
    () => products.filter(p => cart[p.variantId]).map(p => ({ ...p, qty: cart[p.variantId] })),
    [products, cart]
  );
  const total = cartItems.reduce((s, p) => s + p.price * p.qty, 0);
  const count = cartItems.reduce((s, p) => s + p.qty, 0);

  useEffect(() => {
    Promise.all([
      fetch("/api/products").then(r => r.json()),
      fetch("/api/auth/me").then(r => r.json())
    ]).then(([p, me]) => {
      setProducts(p.products || []);
      setUser(me.user || null);
    }).catch(() => setNotice("Could not load the shop. Check your Shopify connection."));
  }, []);

  useEffect(() => {
    const src = document.createElement("script");
    src.src = "https://accounts.google.com/gsi/client";
    src.async = true;
    src.defer = true;
    document.head.appendChild(src);
    return () => { document.head.removeChild(src); };
  }, []);

  const add = (p: Product) => {
    if (!p.available) return;
    setCart(c => ({ ...c, [p.variantId]: (c[p.variantId] || 0) + 1 }));
    setDrawer(true);
  };

  const update = (id: string, qty: number) =>
    setCart(c => { const n = { ...c }; if (qty <= 0) delete n[id]; else n[id] = qty; return n; });

  async function signIn() {
    setLogin(true);
    setTimeout(() => {
      if (!window.google) return;
      window.google.accounts.id.initialize({
        client_id: import.meta.env.VITE_GOOGLE_CLIENT_ID,
        callback: async (response: any) => {
          const r = await fetch("/api/auth/google", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ credential: response.credential })
          });
          const data = await r.json();
          if (data.user) { setUser(data.user); setLogin(false); }
          else setNotice(data.error || "Google sign-in failed.");
        }
      });
      const el = document.getElementById("google-button");
      if (el) window.google.accounts.id.renderButton(el, {
        theme: "outline", size: "large", shape: "pill", text: "continue_with", width: 320
      });
    }, 250);
  }

  async function checkout() {
    if (!user) { signIn(); return; }
    if (!cartItems.length) return;
    setBusy(true); setNotice("");
    try {
      const r = await fetch("/api/checkout/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: cartItems.map(p => ({ variantId: p.variantId, quantity: p.qty })) })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Could not start checkout.");
      const cf = window.Cashfree({ mode: import.meta.env.VITE_CASHFREE_MODE || "sandbox" });
      await cf.checkout({ paymentSessionId: data.paymentSessionId, redirectTarget: "_self" });
    } catch (e: any) {
      setNotice(e.message);
    } finally { setBusy(false); }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setUser(null);
  }

  return (
    <div>
      <div className="announcement">FREE SHIPPING ON ORDERS OVER ₹1,999 · 404 SOCIETY</div>
      <header className="nav">
        <a className="logo" href="#">404<span>°</span></a>
        <nav><a href="#shop">Shop</a><a href="#story">Society</a><a href="#drop">New drop</a></nav>
        <div className="actions">
          <button className="iconBtn" onClick={user ? logout : signIn} aria-label="account">
            {user ? (user.name?.split(" ")[0] || "Account") : "Login"}
          </button>
          <button className="bag" onClick={() => setDrawer(true)}>Bag <b>{count}</b></button>
        </div>
      </header>

      <main>
        <section className="hero" id="drop">
          <div className="heroCopy">
            <p className="eyebrow">ISSUE 04 / 04</p>
            <h1>Dress like<br/><em>you don't</em><br/>belong.</h1>
            <p className="lede">Independent silhouettes for people who were never interested in fitting in.</p>
            <a className="cta" href="#shop">Shop the drop <span>↘</span></a>
          </div>
          <div className="heroCard">
            <div className="stamp">404<br/>SOCIETY</div>
            <div className="heroText">NOT<br/>FOUND.</div>
          </div>
        </section>

        <section className="ticker"><span>NOT FOUND · FOUND HERE · NOT FOUND · FOUND HERE · </span></section>

        <section className="shop" id="shop">
          <div className="sectionHead">
            <div><p className="eyebrow">THE CURRENT DROP</p><h2>Wear the error.</h2></div>
            <span>{products.length} pieces</span>
          </div>
          {notice && <div className="notice">{notice}</div>}
          <div className="grid">
            {products.map(p => (
              <article className="product" key={p.id}>
                <div className="productImage">
                  {p.image ? <img src={p.image} alt={p.title}/> : <div className="placeholder">404</div>}
                  <button onClick={() => add(p)} disabled={!p.available}>{p.available ? "Add +" : "Sold out"}</button>
                </div>
                <div className="productMeta"><div><h3>{p.title}</h3><p>{p.options.map(o => o.value).join(" · ")}</p></div><strong>{money(p.price, p.currency)}</strong></div>
              </article>
            ))}
          </div>
        </section>

        <section className="manifesto" id="story">
          <p className="eyebrow">THE 404 MANIFESTO</p>
          <h2>There is no<br/><em>wrong way</em><br/>to be yourself.</h2>
          <div className="manifestoFoot"><p>404 Society is a dress code for the beautifully out of place. Small drops. Strong cuts. Zero permission required.</p><span>EST. 20XX — INDIA</span></div>
        </section>
      </main>

      <footer><div className="logo">404<span>°</span></div><p>© 404 Society. Made for the not-found.</p><div>IG · MAIL · SOCIETY</div></footer>

      {drawer && <div className="overlay" onClick={() => setDrawer(false)}>
        <aside className="cart" onClick={e => e.stopPropagation()}>
          <div className="cartHead"><h2>Your bag</h2><button onClick={() => setDrawer(false)}>×</button></div>
          {!cartItems.length ? <div className="empty">Your bag is empty.<br/>Find something strange.</div> : <>
            <div className="cartList">{cartItems.map(p => <div className="cartRow" key={p.variantId}>
              {p.image && <img src={p.image} alt=""/>}<div className="cartInfo"><b>{p.title}</b><span>{money(p.price, p.currency)}</span><div className="qty"><button onClick={() => update(p.variantId, p.qty-1)}>−</button><span>{p.qty}</span><button onClick={() => update(p.variantId, p.qty+1)}>+</button></div></div>
            </div>)}</div>
            <div className="cartTotal"><span>Total</span><strong>{money(total)}</strong></div>
            <button className="checkout" onClick={checkout} disabled={busy}>{busy ? "Opening secure checkout…" : user ? "Pay with Cashfree ↗" : "Continue with Google"}</button>
            <small>Secure payment powered by Cashfree. Prices and inventory are validated server-side from Shopify before payment.</small>
          </>}
        </aside>
      </div>}

      {login && <div className="modal" onClick={() => setLogin(false)}><div className="login" onClick={e => e.stopPropagation()}>
        <button className="close" onClick={() => setLogin(false)}>×</button>
        <div className="miniLogo">404°</div><h2>Enter the society.</h2><p>One account. One identity. No passwords to remember.</p>
        <div id="google-button"></div>
        <small>Sign in securely with your Google Account.</small>
      </div></div>}
      <script src="https://sdk.cashfree.com/js/v3/cashfree.js"></script>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
