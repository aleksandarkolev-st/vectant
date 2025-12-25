'use client';

import ExtensionDebugPanel from '@/components/ExtensionDebugPanel';

export default function ExtensionTestPage() {
  return (
    <div style={{
      minHeight: '100vh',
      background: '#0d1117',
      padding: '40px 20px'
    }}>
      <div style={{ maxWidth: '900px', margin: '0 auto' }}>
        <h1 style={{ 
          color: '#58a6ff', 
          marginBottom: '10px',
          fontFamily: 'system-ui'
        }}>
          Synthi Extension System Test
        </h1>
        <p style={{ 
          color: '#8b949e', 
          marginBottom: '30px',
          fontFamily: 'system-ui'
        }}>
          Step-by-step verification that extensions work correctly.
        </p>
        
        <ExtensionDebugPanel />
        
        <div style={{
          marginTop: '30px',
          padding: '20px',
          background: '#161b22',
          borderRadius: '8px',
          fontFamily: 'system-ui',
          color: '#8b949e'
        }}>
          <h2 style={{ color: '#58a6ff', marginTop: 0 }}>Test Checklist</h2>
          <ul style={{ lineHeight: '1.8' }}>
            <li><strong>Step 1:</strong> Worker initializes and signals ready</li>
            <li><strong>Step 2:</strong> Extension code loads without errors</li>
            <li><strong>Step 3:</strong> activate() is called with context</li>
            <li><strong>Step 4:</strong> Commands are registered</li>
            <li><strong>Step 5:</strong> Command execution returns correct value</li>
            <li><strong>Step 6:</strong> Messages are passed between worker and main thread</li>
          </ul>
          
          <h3 style={{ color: '#58a6ff' }}>Performance Requirements</h3>
          <ul style={{ lineHeight: '1.8' }}>
            <li>Activation timeout: 1000ms hard limit</li>
            <li>Typing latency: &lt;10ms while extensions run</li>
            <li>Memory: 64MB per extension limit</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
