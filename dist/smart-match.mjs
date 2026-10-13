const normalized = (value) => String(value ?? '').trim().toLowerCase();
const words = (value) => new Set(normalized(value).split(/[^a-z0-9+#.]+/).filter((word) => word.length > 1));

function overlap(left, right) {
  const a = words(left);
  const b = words(right);
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const word of a) if (b.has(word)) common += 1;
  return common / Math.max(1, Math.min(a.size, b.size));
}

export function scoreJobMatch(profile, job) {
  const skillList = Array.isArray(profile?.skills) ? profile.skills : [];
  const jobSkills = Array.isArray(job?.skills) ? job.skills : [];
  const matchingSkills = skillList.filter((skill) => jobSkills.some((required) => overlap(skill, required) > 0));
  const skillScore = jobSkills.length ? matchingSkills.length / jobSkills.length : 0;
  const roleScore = overlap(profile?.target_role, job?.title);
  const candidateLocation = normalized(profile?.location);
  const jobLocation = normalized(job?.location);
  const locationScore = !candidateLocation || /anywhere|flexible|open to/i.test(candidateLocation)
    ? 0.75
    : jobLocation.includes(candidateLocation.split(/[·,]/)[0].trim()) || candidateLocation.includes(jobLocation.split(/[·,]/)[0].trim())
      ? 1
      : /remote/i.test(candidateLocation) && /remote/i.test(`${jobLocation} ${job?.mode ?? ''}`)
        ? 1
        : 0.25;
  const preferredWork = normalized(profile?.work_style);
  const jobWork = normalized(job?.work_style ?? job?.mode);
  const workScore = !preferredWork || preferredWork === 'flexible' || jobWork.includes(preferredWork) ? 1 : 0.35;
  const experience = Number(profile?.years_experience ?? profile?.experience_years);
  const requiredExperience = Number(job?.exp ?? job?.experience_years ?? 0);
  const experienceScore = Number.isFinite(experience) ? (experience >= requiredExperience ? 1 : Math.max(0.2, experience / Math.max(1, requiredExperience))) : 0.6;
  const score = Math.round((skillScore * 0.55 + roleScore * 0.2 + locationScore * 0.15 + workScore * 0.05 + experienceScore * 0.05) * 100);

  const reasons = [];
  if (matchingSkills.length) reasons.push(`Skills: ${matchingSkills.slice(0, 2).join(', ')}`);
  if (roleScore >= 0.5) reasons.push('Role matches your target');
  if (locationScore >= 0.9) reasons.push('Location fits your preference');
  if (workScore >= 0.9 && preferredWork) reasons.push(`${job?.work_style ?? job?.mode} work style fits`);
  if (!reasons.length) reasons.push('A nearby role to explore and compare');
  return { score, reasons, matchingSkills };
}

export function rankJobsForProfile(profile, jobs = []) {
  return jobs
    .filter((job) => job && job.isActive !== false && job.status !== 'closed' && job.status !== 'paused')
    .map((job) => ({ job, ...scoreJobMatch(profile, job) }))
    .sort((a, b) => b.score - a.score || Number(a.job.posted ?? 0) - Number(b.job.posted ?? 0));
}
