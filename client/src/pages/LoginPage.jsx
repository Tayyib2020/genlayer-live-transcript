import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import PageIntro from "../components/PageIntro.jsx";
import { useAuth } from "../auth.jsx";

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login } = useAuth();
  const [form, setForm] = useState({ username: "", password: "" });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setSaving(true);
    try {
      await login(form);
      const destination = typeof location.state?.from === "string" && location.state.from.startsWith("/") ? location.state.from : "/archive";
      navigate(destination, { replace: true });
    } catch (loginError) {
      setError(loginError.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="container page-stack narrow-page auth-page">
      <PageIntro eyebrow="Sign in" title="Return to your records." description="Your transcript archive is private to your Signal Ledger account." />
      <form className="form-card" onSubmit={handleSubmit}>
        <div className="form-card-header"><span className="form-step">01</span><div><h2>Account access</h2><p>Use the username and password you created for Signal Ledger.</p></div></div>
        <label htmlFor="login-username">Username<input id="login-username" name="username" autoComplete="username" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} required /></label>
        <label htmlFor="login-password">Password<input id="login-password" name="password" type="password" autoComplete="current-password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} required /></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions"><button className="button button-primary" type="submit" disabled={saving}>{saving ? "Signing in…" : "Sign In"}<span aria-hidden="true">↗</span></button></div>
        <p className="auth-switch">Need an account? <Link to="/register">Create an account</Link></p>
      </form>
    </div>
  );
}
