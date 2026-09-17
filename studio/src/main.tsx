import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import './readability.css';
import './product/product.css';
class Boundary extends React.Component<{children:React.ReactNode},{error:boolean}> {
  state={error:false};static getDerivedStateFromError(){return{error:true};}
  render(){return this.state.error?<main className="recovery"><h1>Let’s get your workspace back.</h1><p>The interface encountered an unexpected error. Your saved jobs are unaffected.</p><button onClick={()=>location.reload()}>Reload Molt</button></main>:this.props.children;}
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><Boundary><App/></Boundary></React.StrictMode>);
