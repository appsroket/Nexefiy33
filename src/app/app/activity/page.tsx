import { redirect } from 'next/navigation'

// Activity became the task list.
export default function Page() {
  redirect('/app/tasks')
}
