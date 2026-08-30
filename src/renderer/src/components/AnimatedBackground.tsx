import { useEffect, useRef } from 'react'

// Animated backdrop for the visual overhaul: a slowly-rolling vector wave
// field plus a twinkling starfield, both behind the app content.
//
// Deliberately built with direct canvas/DOM manipulation inside one effect
// rather than React state -- the wave redraws ~46 SVG path `d` attributes and
// the starfield repaints a full canvas every frame, and routing that through
// setState would mean a React render per animation frame for a layer that
// never needs to affect anything else in the tree. Everything here mutates
// refs directly; the component itself renders once.
//
// Mounted as a SIBLING of .app-shell, never a child (see the note at the mount
// site in App.tsx). As a child it painted over the header and toolbar, because
// a positioned element with z-index 0 paints above static in-flow content in
// the same stacking context -- and the opaque base gradient here made that
// immediately visible. Kept outside, both are positioned and .app-shell's
// z-index: 1 settles it.
//
// Fixed-position and `pointer-events: none` throughout, so it never intercepts
// clicks or scroll and can't affect the match-tile list's own layout -- the two
// are visually stacked, not structurally related.

const LINE_COUNT = 40
const POINTS = 56
const VIEW_W = 1440
const VIEW_H = 500

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false
}

function buildLinePath(t: number, time: number): string {
  const baseY = VIEW_H * (0.26 + t * 0.64)
  const amp1 = 40 + t * 74
  const amp2 = 18 + t * 34
  const amp3 = 10 + t * 20
  const breathe1 = 0.75 + 0.25 * Math.sin(time * 0.07 + t * 1.6)
  const breathe2 = 0.75 + 0.25 * Math.sin(time * 0.13 - t * 2.1)

  let d = ''
  for (let p = 0; p <= POINTS; p++) {
    const px = (p / POINTS) * VIEW_W
    const nx = p / POINTS
    const wave =
      Math.sin(nx * 4.4 + time * 0.34 + t * 2.4) * amp1 * breathe1 +
      Math.sin(nx * 9.8 - time * 0.5 + t * 5.1) * amp2 * breathe2 +
      Math.sin(nx * 2.1 + time * 0.19 - t * 1.1) * amp3 +
      Math.sin(nx * 14.5 + time * 0.62 + t * 8.3) * (amp2 * 0.35)
    const py = baseY + wave
    d += p === 0 ? `M ${px.toFixed(1)} ${py.toFixed(1)}` : ` L ${px.toFixed(1)} ${py.toFixed(1)}`
  }
  return d
}

interface Star {
  x: number
  y: number
  r: number
  phase: number
  speed: number
}

function seedStars(width: number, height: number): Star[] {
  // Biased toward the area above the wave band, thinning out into it -- the
  // wave's own mask already fades it out, this just keeps stars from
  // clustering visibly on top of the brightest part of the ridge.
  const waveTop = height * 0.4
  const count = Math.round((width * height) / 11000)
  const stars: Star[] = []
  for (let i = 0; i < count; i++) {
    const y = Math.random() * height
    if (y > waveTop && Math.random() > 0.25) continue
    stars.push({
      x: Math.random() * width,
      y,
      r: Math.random() * 1.1 + 0.3,
      phase: Math.random() * Math.PI * 2,
      speed: 0.008 + Math.random() * 0.014
    })
  }
  return stars
}

function AnimatedBackground(): JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const glowRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const svg = svgRef.current
    const canvas = canvasRef.current
    if (!svg || !canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const reducedMotion = prefersReducedMotion()

    // One <path> per line, created once and reused every frame -- only the
    // `d` attribute changes, so this never touches the DOM tree shape.
    const paths: Array<{ el: SVGPathElement; t: number }> = []
    for (let i = 0; i < LINE_COUNT; i++) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      const t = i / (LINE_COUNT - 1)
      const hueMix = Math.sin(t * Math.PI)
      const r = Math.round(120 + hueMix * 130)
      const g = Math.round(40 + hueMix * 10)
      const b = Math.round(200 + hueMix * 50)
      path.setAttribute('fill', 'none')
      path.setAttribute('stroke', `rgb(${r}, ${g}, ${b})`)
      path.setAttribute('stroke-width', (0.9 + hueMix * 1.4).toFixed(2))
      path.setAttribute('stroke-opacity', (0.08 + hueMix * 0.45).toFixed(2))
      path.setAttribute('stroke-linecap', 'round')
      svg.appendChild(path)
      paths.push({ el: path, t })
    }

    let stars: Star[] = []

    function resize(): void {
      const dpr = window.devicePixelRatio || 1
      const w = window.innerWidth
      const h = window.innerHeight
      canvas!.width = w * dpr
      canvas!.height = h * dpr
      canvas!.style.width = `${w}px`
      canvas!.style.height = `${h}px`
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
      stars = seedStars(w, h)
    }

    resize()
    window.addEventListener('resize', resize)

    function drawStars(time: number): void {
      const w = window.innerWidth
      const h = window.innerHeight
      ctx!.clearRect(0, 0, w, h)
      for (const s of stars) {
        const twinkle = reducedMotion
          ? 0.6
          : 0.3 + 0.5 * (0.5 + 0.5 * Math.sin(time * s.speed + s.phase))
        ctx!.beginPath()
        ctx!.arc(s.x, s.y, s.r, 0, Math.PI * 2)
        ctx!.fillStyle = `rgba(225, 205, 250, ${twinkle.toFixed(3)})`
        ctx!.fill()
      }
    }

    function onMouseMove(e: MouseEvent): void {
      glowRef.current?.style.setProperty(
        'transform',
        `translate(${e.clientX}px, ${e.clientY}px) translate(-50%, -50%)`
      )
    }
    window.addEventListener('mousemove', onMouseMove)

    // Respecting prefers-reduced-motion: render one static frame (wave shape
    // frozen, stars at a fixed brightness) instead of looping requestAnimationFrame
    // forever. The cursor glow still follows the pointer either way -- that's a
    // direct response to input, not an ambient animation.
    if (reducedMotion) {
      for (const { el, t } of paths) el.setAttribute('d', buildLinePath(t, 0))
      drawStars(0)
      return () => {
        window.removeEventListener('resize', resize)
        window.removeEventListener('mousemove', onMouseMove)
      }
    }

    let rafId = 0
    let animationRunning = false
    const start = performance.now()
    function frame(now: number): void {
      if (!animationRunning) return
      const t = (now - start) / 1000
      for (const { el, t: lt } of paths) el.setAttribute('d', buildLinePath(lt, t))
      drawStars(now)
      rafId = requestAnimationFrame(frame)
    }

    // A fullscreen element is painted in its own top layer, so none of this
    // background is visible while a VOD is fullscreen. Continuing to rebuild
    // 40 SVG paths and repaint a viewport-sized canvas every frame still uses
    // the renderer/GPU, though, and competes directly with video playback.
    // Pause the loop while fullscreen (and while the window is hidden), then
    // resume the same animation when the app becomes visible again.
    function syncAnimation(): void {
      const shouldRun = !document.hidden && document.fullscreenElement === null
      if (shouldRun === animationRunning) return
      animationRunning = shouldRun
      if (shouldRun) {
        rafId = requestAnimationFrame(frame)
      } else {
        cancelAnimationFrame(rafId)
      }
    }

    document.addEventListener('fullscreenchange', syncAnimation)
    document.addEventListener('visibilitychange', syncAnimation)
    syncAnimation()

    return () => {
      animationRunning = false
      cancelAnimationFrame(rafId)
      document.removeEventListener('fullscreenchange', syncAnimation)
      document.removeEventListener('visibilitychange', syncAnimation)
      window.removeEventListener('resize', resize)
      window.removeEventListener('mousemove', onMouseMove)
    }
  }, [])

  return (
    <div className="animated-bg" aria-hidden="true">
      <div className="animated-bg-root" />
      <div className="animated-bg-wave-glow" />
      <canvas ref={canvasRef} className="animated-bg-stars" />
      <div className="animated-bg-wave-wrap">
        <svg ref={svgRef} viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} preserveAspectRatio="none" />
      </div>
      <div ref={glowRef} className="animated-bg-cursor-glow" />
    </div>
  )
}

export default AnimatedBackground
