export default function ErrorState({ message, retry }) {
  return (
    <div className="state-card error-state" role="alert">
      <span className="state-icon">!</span>
      <div><h2>Could not load this view</h2><p>{message}</p></div>
      {retry && <button className="button button-secondary" onClick={retry}>Try again</button>}
    </div>
  );
}
