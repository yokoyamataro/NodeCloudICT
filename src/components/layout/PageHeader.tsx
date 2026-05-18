import { type ReactNode } from 'react'
import { useProjectListStore } from '@/stores/projectListStore'
import { useFarmStore } from '@/stores/farmStore'

interface PageHeaderProps {
  title: string
  subtitle?: string
  icon?: ReactNode
  actions?: ReactNode
}

export function PageHeader({ title, subtitle, icon, actions }: PageHeaderProps) {
  const currentProject = useProjectListStore((state) => state.currentProject)
  const currentFarm = useFarmStore((state) => state.currentFarm)

  // プロジェクト名と工区名を取得
  const projectName = currentProject?.name || ''
  const farmName = currentFarm?.name || ''

  // 表示用のパンくずリスト形式
  const breadcrumb = [projectName, farmName].filter(Boolean).join(' / ')

  return (
    <div className="p-4 border-b bg-white flex items-center justify-between">
      <div>
        <div className="flex items-center gap-2">
          {breadcrumb && (
            <>
              <span className="text-sm text-muted-foreground">{breadcrumb}</span>
              <span className="text-muted-foreground">/</span>
            </>
          )}
          <h1 className="text-xl font-bold flex items-center gap-2">
            {icon}
            {title}
          </h1>
        </div>
        {subtitle && (
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        )}
      </div>
      {actions && <div>{actions}</div>}
    </div>
  )
}
