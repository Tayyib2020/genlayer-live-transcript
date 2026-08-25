import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import PageIntro from "../components/PageIntro.jsx";
import { useAuth } from "../auth.jsx";

export default function RegisterPage() {
  const navigate = useNavigate();
  const { register } = useAuth();
  const [form, setForm] = useState({ username: "", password: "", confirmPassword: "" });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    if (form.password !== form.confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setSaving(true);
    try {
      await register({ username: form.username, password: form.password });
      navigate("/archive", { replace: true });
    } catch (registerError) {
      setError(registerError.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="container page-stack narrow-page auth-page">
      <PageIntro eyebrow="Create account" title="Keep your records private." description="Create a username and password to own your Signal Ledger archive." />
      <form className="form-card" onSubmit={handleSubmit}>
        <div className="form-card-header"><span className="form-step">01</span><div><h2>Account details</h2><p>Usernames are 3–30 characters using letters, numbers, underscores, or hyphens.</p></div></div>
        <label htmlFor="register-username">Username<input id="register-username" name="username" autoComplete="username" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} minLength={3} maxLength={30} required /></label>
        <label htmlFor="register-password">Password<input id="register-password" name="password" type="password" autoComplete="new-password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} minLength={8} maxLength={128} required /></label>
        <label htmlFor="register-confirm-password">Confirm password<input id="register-confirm-password" name="confirmPassword" type="password" autoComplete="new-password" value={form.confirmPassword} onChange={(event) => setForm({ ...form, confirmPassword: event.target.value })} minLength={8} maxLength={128} required /></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions"><button className="button button-primary" type="submit" disabled={saving}>{saving ? "Creating…" : "Create Account"}<span aria-hidden="true">↗</span></button></div>
        <p className="auth-switch">Already have an account? <Link to="/login">Sign in</Link></p>
      </form>
    </div>
  );
}
