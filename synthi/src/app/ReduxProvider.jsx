'use client';
import { Provider } from 'react-redux';
import { store } from '@/redux/store';
import StoreHydrator from '@/components/StoreHydrator';

export function ReduxProvider({ children }) {
  return (
    <Provider store={store}>
      <StoreHydrator />
      {children}
    </Provider>
  );
}
// Note: This file assumes the root layout/component is wrapped by <ReduxProvider>