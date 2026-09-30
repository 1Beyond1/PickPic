import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { COLORS, COLORS_DARK } from '../../constants/theme';
import { SegmentedControl } from '../../components/SegmentedControl';

let mockDark = false;
jest.mock('../../hooks/useThemeColor', () => ({
    useThemeColor: () => {
        const palette = require('../../constants/theme');
        return { colors: mockDark ? palette.COLORS_DARK : palette.COLORS };
    },
}));

describe.each([false, true])('segmented choice, dark=%s', dark => {
    beforeEach(() => { mockDark = dark; });

    it('shows the saved selection and changes only when pressed', () => {
        const onChange = jest.fn();
        const options = [{ value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }];
        const view = render(<SegmentedControl label="主题" value="light" options={options} onChange={onChange} />);
        expect(screen.getByRole('radio', { name: '浅色', checked: true })).toBeTruthy();
        expect(screen.getByRole('radio', { name: '深色', checked: false })).toBeTruthy();
        const colors = dark ? COLORS_DARK : COLORS;
        expect(screen.getByText('浅色')).toHaveStyle({ color: colors.actionForeground });
        expect(onChange).not.toHaveBeenCalled();
        fireEvent.press(screen.getByRole('radio', { name: '深色' }));
        expect(onChange).toHaveBeenCalledWith('dark');
        view.rerender(<SegmentedControl label="主题" value="dark" options={options} onChange={onChange} />);
        expect(screen.getByRole('radio', { name: '深色', checked: true })).toBeTruthy();
    });
});

it('keeps numeric group-size values numeric', () => {
    const onChange = jest.fn();
    render(<SegmentedControl label="每组数量" value={10} options={[{ value: 10, label: '10' }, { value: 20, label: '20' }]} onChange={onChange} />);
    fireEvent.press(screen.getByRole('radio', { name: '20' }));
    expect(onChange).toHaveBeenCalledWith(20);
});
