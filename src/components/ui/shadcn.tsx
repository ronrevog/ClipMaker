import React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import clsx from 'clsx';

/**
 * shadcn/ui Primitive & Studio Design System Components
 * Built on Radix UI primitives + clsx with compact MacBook-friendly proportions.
 */

export const cn = (...inputs: Array<string | undefined | null | false>) => clsx(inputs);

/* ============================================================================
 * 1. SHADCN BUTTON
 * ========================================================================== */
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive' | 'active' | 'amber' | 'purple' | 'emerald';
  size?: 'default' | 'sm' | 'xs' | 'icon' | 'icon-sm';
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'outline', size = 'sm', type = 'button', ...props }, ref) => {
    return (
      <button
        ref={ref}
        type={type}
        className={cn(
          'shadcn-btn',
          `shadcn-btn--${variant}`,
          `shadcn-btn--size-${size}`,
          className
        )}
        {...props}
      />
    );
  }
);
Button.displayName = 'Button';

/* ============================================================================
 * 2. SHADCN BADGE
 * ========================================================================== */
export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: 'default' | 'secondary' | 'outline' | 'blue' | 'amber' | 'purple' | 'emerald' | 'destructive';
}

export const Badge: React.FC<BadgeProps> = ({
  className,
  variant = 'secondary',
  ...props
}) => {
  return (
    <span
      className={cn('shadcn-badge', `shadcn-badge--${variant}`, className)}
      {...props}
    />
  );
};

/* ============================================================================
 * 3. SHADCN CARD
 * ========================================================================== */
export const Card: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  ...props
}) => <div className={cn('shadcn-card', className)} {...props} />;

export const CardHeader: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  ...props
}) => <div className={cn('shadcn-card-header', className)} {...props} />;

export const CardTitle: React.FC<React.HTMLAttributes<HTMLHeadingElement>> = ({
  className,
  ...props
}) => <h4 className={cn('shadcn-card-title', className)} {...props} />;

export const CardContent: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  ...props
}) => <div className={cn('shadcn-card-content', className)} {...props} />;

/* ============================================================================
 * 4. SHADCN SEPARATOR
 * ========================================================================== */
export const Separator: React.FC<{
  orientation?: 'horizontal' | 'vertical';
  className?: string;
}> = ({ orientation = 'vertical', className }) => (
  <div
    role="separator"
    className={cn(
      orientation === 'vertical' ? 'shadcn-separator-v' : 'shadcn-separator-h',
      className
    )}
  />
);

/* ============================================================================
 * 5. SHADCN TABS (Radix Tabs)
 * ========================================================================== */
export const Tabs = TabsPrimitive.Root;

export const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn('shadcn-tabs-list', className)}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

export const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn('shadcn-tabs-trigger', className)}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

export const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn('shadcn-tabs-content', className)}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

/* ============================================================================
 * 6. SHADCN DROPDOWN MENU (Radix DropdownMenu)
 * ========================================================================== */
export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;

export const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 5, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn('rx-dropdown-content shadcn-dropdown-content', className)}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
));
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName;

export const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    className={cn('rx-dropdown-item', className)}
    {...props}
  />
));
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName;

export const DropdownMenuLabel: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  ...props
}) => <div className={cn('rx-dropdown-label', className)} {...props} />;

export const DropdownMenuSeparator: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  ...props
}) => (
  <DropdownMenuPrimitive.Separator
    className={cn('rx-dropdown-separator', className)}
    {...props}
  />
);

/* ============================================================================
 * 7. SHADCN SWITCH / TOGGLE PILL
 * ========================================================================== */
export interface ToggleSwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label?: string;
  shortcut?: string;
  title?: string;
  icon?: React.ReactNode;
  activeColor?: 'blue' | 'amber' | 'emerald' | 'purple';
  className?: string;
}

export const TogglePill: React.FC<ToggleSwitchProps> = ({
  checked,
  onCheckedChange,
  label,
  shortcut,
  title,
  icon,
  activeColor = 'blue',
  className,
}) => {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onCheckedChange(!checked)}
      title={title}
      className={cn(
        'shadcn-toggle-pill',
        checked && `shadcn-toggle-pill--on-${activeColor}`,
        className
      )}
    >
      <span className={cn('shadcn-toggle-dot', checked && 'is-on')} />
      {icon}
      {label && <span>{label}</span>}
      {shortcut && <kbd className="shadcn-kbd">{shortcut}</kbd>}
    </button>
  );
};

/* ============================================================================
 * 8. SHADCN TOOLTIP WRAPPER
 * ========================================================================== */
export const QuickTooltip: React.FC<{
  content: React.ReactNode;
  children: React.ReactElement;
  side?: 'top' | 'bottom' | 'left' | 'right';
}> = ({ content, children, side = 'top' }) => (
  <TooltipPrimitive.Root>
    <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content className="rx-tooltip-content" side={side} sideOffset={5}>
        {content}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  </TooltipPrimitive.Root>
);
