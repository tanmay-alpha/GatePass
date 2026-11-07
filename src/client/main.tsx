import React from 'react';
import { createRoot } from 'react-dom/client';
import { AdminApp } from './admin/AdminApp';
import { ScannerApp } from './scanner/ScannerApp';
import '@fontsource-variable/inter';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root is missing from index.html');

// Two independent apps share one bundle: /scan for door staff, everything else for admins.
const isScanner = window.location.pathname.startsWith('/scan');
document.title = isScanner ? 'GatePass Scanner' : 'GatePass Admin';

createRoot(container).render(<React.StrictMode>{isScanner ? <ScannerApp /> : <AdminApp />}</React.StrictMode>);
