import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api.js";
import PageIntro from "../components/PageIntro.jsx";

export default function NewSessionPage() {
  const navigate = useNavigate();
  const [form, setForm] = useState({ title: "", sourceUrl: "" });
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const data = await api.createSession(form);
      navigate(`/session/${data.session.id}/live`);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="container page-stack narrow-page">
      <PageIntro eyebrow="New record" title="Start with the source." description="Name the conversation now. Browser tab-audio capture begins in the live workspace." />
      <form className="form-card" onSubmit={handleSubmit}>
        <div className="form-card-header"><span className="form-step">01</span><div><h2>Session details</h2><p>These details are stored in PostgreSQL and can be revisited after creation.</p></div></div>
        <label htmlFor="title">Session title <span aria-hidden="true">*</span><input id="title" name="title" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="GenLayer Weekly Community AMA" maxLength={160} required /></label>
        <label htmlFor="sourceUrl">Source URL <span className="optional">Optional</span><input id="sourceUrl" name="sourceUrl" type="url" value={form.sourceUrl} onChange={(event) => setForm({ ...form, sourceUrl: event.target.value })} placeholder="https://x.com/i/spaces/..." /></label>
        <div className="form-help"><span className="info-icon">i</span><p>Source links are metadata only. The live workspace uses your browser tab rather than undocumented platform media endpoints.</p></div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions"><button className="button button-primary" type="submit" disabled={saving}>{saving ? "Creating…" : "Create Session"}<span aria-hidden="true">↗</span></button></div>
      </form>
    </div>
  );
}
