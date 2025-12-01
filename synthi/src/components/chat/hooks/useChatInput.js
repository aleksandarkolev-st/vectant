import { useCallback, useState } from 'react';

export const useChatInput = (onSubmit) => {
    const [inputValue, setInputValue] = useState('');

    const handleSubmit = useCallback(() => {
        if (!inputValue.trim()) return;
        if (typeof onSubmit === 'function') {
            onSubmit(inputValue);
        }
    }, [inputValue, onSubmit]);

    const handleKeyPress = useCallback((e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit();
        }
    }, [handleSubmit]);

    return {
        inputValue,
        setInputValue,
        handleKeyPress,
        handleSubmit,
    };
};
