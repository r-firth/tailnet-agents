import { Component, type ReactNode } from 'react';

/** Keeps one broken panel from blanking the whole Desk: it shows a small note and the rest keeps working. */
export class Boundary extends Component<{ name: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error(`${this.props.name} crashed`, error); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="boundary" role="alert">
        <b>{this.props.name} hit a problem and was skipped.</b>
        <span>{this.state.error.message.slice(0, 200)}</span>
        <button className="btn sm" onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    );
  }
}
