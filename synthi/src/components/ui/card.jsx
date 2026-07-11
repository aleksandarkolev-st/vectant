"use client"
import * as React from "react"

import { cn } from "@/lib/utils"

function Card({
  className,
  style,
  ...props
}) {
  return (
    <div
      data-slot="card"
      className={cn(
        "flex flex-col gap-4 rounded-[var(--radius-panel)] border py-4",
        className
      )}
      style={{
        background: 'color-mix(in srgb, var(--bg-panel) 88%, var(--bg-editor) 12%)',
        borderColor: 'var(--border-subtle)',
        color: 'var(--text-primary)',
        ...style,
      }}
      {...props} />
  );
}

function CardHeader({
  className,
  style,
  ...props
}) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-2 border-b px-4 pb-3 has-data-[slot=card-action]:grid-cols-[1fr_auto]",
        className
      )}
      style={{
        borderColor: 'var(--border-subtle)',
        ...style,
      }}
      {...props} />
  );
}

function CardTitle({
  className,
  style,
  ...props
}) {
  return (
    <div
      data-slot="card-title"
      className={cn("leading-none font-semibold", className)}
      style={{
        color: 'var(--text-primary)',
        ...style,
      }}
      {...props} />
  );
}

function CardDescription({
  className,
  style,
  ...props
}) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-sm leading-relaxed", className)}
      style={{
        color: 'var(--text-secondary)',
        ...style,
      }}
      {...props} />
  );
}

function CardAction({
  className,
  ...props
}) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className
      )}
      {...props} />
  );
}

function CardContent({
  className,
  ...props
}) {
  return (<div data-slot="card-content" className={cn("px-4", className)} {...props} />);
}

function CardFooter({
  className,
  ...props
}) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center px-6 [.border-t]:pt-6", className)}
      {...props} />
  );
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
}
