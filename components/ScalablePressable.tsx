import React, { ReactNode } from 'react';
import { GestureResponderEvent, Pressable, StyleProp, ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

interface ScalablePressableProps {
    scaleTo?: number;
    style?: StyleProp<ViewStyle>;
    children?: ReactNode;
    onPress?: () => void;
    onLongPress?: () => void;
    onPressIn?: (e: GestureResponderEvent) => void;
    onPressOut?: (e: GestureResponderEvent) => void;
    disabled?: boolean;
}

export const ScalablePressable: React.FC<ScalablePressableProps> = ({
    children,
    scaleTo = 0.9,
    style,
    onPress,
    onLongPress,
    onPressIn,
    onPressOut,
    disabled,
}) => {
    const scale = useSharedValue(1);

    const animatedStyle = useAnimatedStyle(() => ({
        transform: [{ scale: scale.value }],
    }));

    const handlePressIn = (event: GestureResponderEvent) => {
        scale.value = withSpring(scaleTo);
        onPressIn?.(event);
    };

    const handlePressOut = (event: GestureResponderEvent) => {
        scale.value = withSpring(1);
        onPressOut?.(event);
    };

    return (
        <Pressable
            onPress={onPress}
            onLongPress={onLongPress}
            onPressIn={handlePressIn}
            onPressOut={handlePressOut}
            disabled={disabled}
        >
            <Animated.View style={[style as any, animatedStyle]}>
                {children}
            </Animated.View>
        </Pressable>
    );
};
