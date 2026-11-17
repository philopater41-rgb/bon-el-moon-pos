'use client';

import React from 'react';
import { Database } from 'lucide-react';

interface NeonSpinnerProps {
  label?: string;
  subLabel?: string;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

export function NeonSpinner({
  label = 'جاري تحميل وتحديث البيانات...',
  subLabel = 'لحظات ويتم عرض البيانات',
  className = '',
  size = 'md',
}: NeonSpinnerProps) {
  const isSm = size === 'sm';
  const isLg = size === 'lg';

  const outerSize = isSm ? 'w-8 h-8' : isLg ? 'w-16 h-16' : 'w-12 h-12';
  const innerSize = isSm ? 'w-5 h-5' : isLg ? 'w-10 h-10' : 'w-8 h-8';
  const iconSize = isSm ? 'w-3 h-3' : isLg ? 'w-5 h-5' : 'w-4 h-4';

  return (
    <div className={`flex flex-col items-center justify-center p-8 gap-3 my-2 w-full select-none ${className}`}>
      <div className="relative flex items-center justify-center">
        {/* Soft Neon Ambient Glow */}
        <div className="absolute w-16 h-16 rounded-full bg-cyan-500/15 blur-xl animate-pulse" />
        
        {/* Outer Ring - Clockwise Cyan */}
        <div className={`${outerSize} rounded-full border-2 border-cyan-500/20 border-t-cyan-400 border-r-cyan-400 animate-spin`} />
        
        {/* Inner Ring - Counter-Clockwise Purple */}
        <div
          className={`absolute ${innerSize} rounded-full border-2 border-purple-500/20 border-b-purple-400 border-l-purple-400 animate-spin`}
          style={{ animationDirection: 'reverse', animationDuration: '1.2s' }}
        />
        
        {/* Center Pulsing Cloud Database Icon */}
        <Database className={`absolute ${iconSize} text-cyan-300 animate-pulse`} />
      </div>

      <div className="text-center space-y-1">
        <span className="text-xs font-semibold text-white tracking-wide block drop-shadow-sm">
          {label}
        </span>
        {subLabel && (
          <span className="text-[11px] text-cyan-400/80 block">
            {subLabel}
          </span>
        )}
      </div>
    </div>
  );
}

export function NeonBadge({ label = 'جاري تحديث البيانات...' }: { label?: string }) {
  return (
    <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 text-xs shadow-sm animate-pulse select-none">
      <div className="relative flex items-center justify-center w-3 h-3">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75" />
        <Database className="relative w-2.5 h-2.5 text-cyan-300" />
      </div>
      <span className="font-medium text-[11px]">{label}</span>
    </div>
  );
}
