import React from 'react'
import { AudioLines, BookOpen, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Square, Play, Pause, Settings, Menu, X, Moon, Volume2, Ellipsis, Search, Upload, Plus, Check, Headphones, Pencil, Library, Bookmark, LoaderCircle, ListTodo, HardDrive, Cpu, Clock3, CircleAlert } from 'lucide-react'

const icons = { AudioLines, BookOpen, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Square, Play, Pause, Settings, Menu, X, Moon, Volume2, Ellipsis, Search, Upload, Plus, Check, Headphones, Pencil, Library, Bookmark, LoaderCircle, ListTodo, HardDrive, Cpu, Clock3, CircleAlert }
export function Icon({ name, size = 16 }) {
  const Component = icons[name]
  return Component ? <Component size={size} strokeWidth={1.8} aria-hidden="true"/> : null
}
