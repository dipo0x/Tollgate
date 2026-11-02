import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/base.css'
import DocsPage from './DocsPage'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DocsPage />
  </StrictMode>,
)
